/**
 * 调度器重试闭环（第 7 项）验收：
 *   1. 到期的 FAILED_RETRYABLE 会被 tick() 自动提升回 READY 并被认领（不再一撞就死）
 *   2. 未到期的不会被提前放行
 *   3. retryCount 真正耗尽才落 FAILED_FINAL（终态，UI 可见）
 *   4. 写锁冲突（另一 Codex 进程持 writer）走独立退避：不消耗 retryCount，
 *      且对方放锁后下一个到期点自动接上 —— 对应「用户关掉桌面版那一刻自动补跑」
 *
 * 用真实的 SqliteRepository（内存库），只把 app-server 与 task-engine 用替身顶掉，
 * 因此覆盖了 tick -> promoteRetryableTasks -> claim -> runTask -> 失败分类 的完整链路。
 *
 * 运行：tsx --test apps/daemon/test/scheduler-retry.test.ts
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRepository } from "@car/persistence";
import { createLogger } from "@car/logger";
import type { AppServerClient } from "@car/app-server-client";
import type { TaskEngine } from "@car/task-engine";
import type { QuotaSnapshot } from "@car/quota-engine";
import { Scheduler, isWriterConflict, writerConflictBackoffMs } from "../src/scheduler.js";

const WRITER_CONFLICT =
  "thread-store conflict: thread 01a09bc3-dff2-78a3-9b97-f12797f07007 already has an active writer";

const createdProjects: string[] = [];

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "car-sched-"));
  createdProjects.push(dir);
  return dir;
}

function makeScheduler(
  repo: SqliteRepository,
  opts: { onTurn?: (taskId: string) => Promise<unknown> } = {},
): { scheduler: Scheduler; calls: string[] } {
  const calls: string[] = [];
  const client = {
    isHealthy: () => true,
    request: async () => {
      throw new Error("unexpected rpc in scheduler test");
    },
  } as unknown as AppServerClient;
  const engine = {
    runOneTurn: async (task: { id: string }) => {
      calls.push(task.id);
      if (opts.onTurn) return opts.onTurn(task.id);
      return { status: "completed" };
    },
  } as unknown as TaskEngine;
  const quota = { status: "available", blockingBuckets: [] } as unknown as QuotaSnapshot;
  const scheduler = new Scheduler({
    client,
    repo,
    engine,
    logger: createLogger({ level: "error" }),
    isAutoRunEnabled: () => true,
    getQuotaSnapshot: () => quota,
  });
  return { scheduler, calls };
}

function setup(): { repo: SqliteRepository; project: string } {
  const repo = new SqliteRepository(":memory:");
  repo.migrate();
  return { repo, project: makeProject() };
}

test("retry: a due FAILED_RETRYABLE task is promoted to READY and claimed again", async () => {
  const { repo, project } = setup();
  const t = repo.createTask({
    title: "flaky", projectPath: project, originalGoal: "g",
    mode: "resume_thread", threadId: "th-1", priority: 50,
  });
  repo.forceStatus(t.id, "RUNNING");
  repo.forceStatus(t.id, "FAILED_RETRYABLE");
  repo.patch(t.id, { retryCount: 1, nextRunAt: Date.now() - 1_000, lastError: "boom" });

  const { scheduler, calls } = makeScheduler(repo);
  await scheduler.tick();

  // 被提升 + 被认领（替身引擎不改状态，因此停在 PREPARING 即证明 claim 成功）
  assert.deepEqual(calls, [t.id]);
  assert.equal(repo.getTask(t.id)?.status, "PREPARING");
  const events = repo.listEvents({ taskId: t.id }).map((e) => e.method);
  assert.ok(events.includes("retry/promoted"), "should record retry/promoted");
  repo.close();
});

test("retry: a not-yet-due FAILED_RETRYABLE task is left alone", async () => {
  const { repo, project } = setup();
  const t = repo.createTask({
    title: "waiting backoff", projectPath: project, originalGoal: "g", priority: 50,
  });
  repo.forceStatus(t.id, "RUNNING");
  repo.forceStatus(t.id, "FAILED_RETRYABLE");
  repo.patch(t.id, { retryCount: 1, nextRunAt: Date.now() + 60_000 });

  const { scheduler, calls } = makeScheduler(repo);
  await scheduler.tick();

  assert.deepEqual(calls, []);
  assert.equal(repo.getTask(t.id)?.status, "FAILED_RETRYABLE");
  repo.close();
});

test("retry: exhausted retryCount lands in FAILED_FINAL instead of hanging forever", async () => {
  const { repo, project } = setup();
  const t = repo.createTask({
    title: "hopeless", projectPath: project, originalGoal: "g", maxRetryCount: 3, priority: 50,
  });
  repo.forceStatus(t.id, "RUNNING");
  repo.forceStatus(t.id, "FAILED_RETRYABLE");
  repo.patch(t.id, { retryCount: 3, nextRunAt: Date.now() - 1_000, lastError: "boom" });

  const { scheduler, calls } = makeScheduler(repo);
  await scheduler.tick();

  assert.deepEqual(calls, []);
  assert.equal(repo.getTask(t.id)?.status, "FAILED_FINAL");
  assert.ok(repo.listEvents({ taskId: t.id }).some((e) => e.method === "retry/exhausted"));
  repo.close();
});

test("writer conflict: backs off with its own counter and never burns retryCount", async () => {
  const { repo, project } = setup();
  const t = repo.createTask({
    title: "blocked by desktop app", projectPath: project, originalGoal: "g",
    mode: "resume_thread", threadId: "01a09bc3-dff2-78a3-9b97-f12797f07007", priority: 100,
  });

  const before = Date.now();
  const { scheduler } = makeScheduler(repo, {
    onTurn: async () => {
      throw new Error(WRITER_CONFLICT);
    },
  });
  await scheduler.tick();

  const failed = repo.getTask(t.id);
  assert.equal(failed?.status, "FAILED_RETRYABLE");
  assert.equal(failed?.retryCount, 0, "conflict must NOT consume retryCount");
  assert.equal(failed?.conflictRetryCount, 1);
  // lastError 原样保留错误文本（生产里 app-server 抛的是 JSON-RPC 错误对象，
  // String(e) 得到不带 "Error: " 前缀的裸消息；这里只断言包含即可）
  assert.ok(failed?.lastError?.includes("already has an active writer"), "lastError keeps the raw conflict text");
  assert.ok(
    (failed?.nextRunAt ?? 0) >= before + 59_000 && (failed?.nextRunAt ?? 0) <= before + 61_000,
    "first conflict should back off ~60s",
  );
  assert.ok(
    repo.listEvents({ taskId: t.id }).some((e) => e.method === "retry/deferred-writer-conflict"),
    "should record the deferred conflict",
  );

  // 退避期内不动
  const { scheduler: s2, calls } = makeScheduler(repo);
  await s2.tick();
  assert.deepEqual(calls, []);
  assert.equal(repo.getTask(t.id)?.status, "FAILED_RETRYABLE");

  // 模拟「用户关掉桌面版、锁已释放」：把 nextRunAt 拨到过去，下一个 tick 应自动接上
  repo.patch(t.id, { nextRunAt: Date.now() - 1 });
  const { scheduler: s3, calls: calls3 } = makeScheduler(repo);
  await s3.tick();
  assert.deepEqual(calls3, [t.id], "should auto-resume once the lock is gone");
  assert.equal(repo.getTask(t.id)?.conflictRetryCount, 1, "counter keeps its history");
  repo.close();
});

test("classifier: recognises the three writer-conflict shapes and nothing else", () => {
  assert.equal(isWriterConflict(WRITER_CONFLICT), true);
  assert.equal(isWriterConflict("thread-store conflict"), true);
  assert.equal(isWriterConflict("THREAD_ACTIVE_ELSEWHERE: thread x status=active"), true);
  assert.equal(isWriterConflict("turn/start returned no turn.id"), false);
  assert.equal(isWriterConflict("boom"), false);
});

test("backoff: 60s, 120s, 240s … capped at 15 minutes", () => {
  assert.equal(writerConflictBackoffMs(1), 60_000);
  assert.equal(writerConflictBackoffMs(2), 120_000);
  assert.equal(writerConflictBackoffMs(3), 240_000);
  assert.equal(writerConflictBackoffMs(8), 15 * 60_000);
  assert.equal(writerConflictBackoffMs(99), 15 * 60_000);
  assert.equal(writerConflictBackoffMs(0), 60_000);
});

after(() => {
  for (const dir of createdProjects) rmSync(dir, { recursive: true, force: true });
});
