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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
  opts: {
    onTurn?: (taskId: string) => Promise<unknown>;
    /** 顶掉默认替身：自动发现相关的用例需要真实的 thread/list + thread/read 应答 */
    client?: AppServerClient;
    /** 额度快照替身；默认 available（即「额度闸门不拦」） */
    quota?: QuotaSnapshot;
  } = {},
): { scheduler: Scheduler; calls: string[]; rpcCalls: string[] } {
  const calls: string[] = [];
  const rpcCalls: string[] = [];
  const client = opts.client ?? ({
    isHealthy: () => true,
    request: async () => {
      throw new Error("unexpected rpc in scheduler test");
    },
  } as unknown as AppServerClient);
  // 记录所有出站 RPC —— 「额度耗尽时是否仍然扫描会话」只能从这里看出来
  const rawRequest = (client as unknown as {
    request: (m: string, p?: Record<string, unknown>) => Promise<unknown>;
  }).request.bind(client);
  const recorded = {
    isHealthy: () => true,
    request: (m: string, p?: Record<string, unknown>) => {
      rpcCalls.push(m);
      return rawRequest(m, p);
    },
  } as unknown as AppServerClient;
  const engine = {
    runOneTurn: async (task: { id: string }) => {
      calls.push(task.id);
      if (opts.onTurn) return opts.onTurn(task.id);
      return { status: "completed" };
    },
  } as unknown as TaskEngine;
  const quota = opts.quota ?? ({ status: "available", blockingBuckets: [] } as unknown as QuotaSnapshot);
  const scheduler = new Scheduler({
    client: recorded,
    repo,
    engine,
    logger: createLogger({ level: "error" }),
    isAutoRunEnabled: () => true,
    getQuotaSnapshot: () => quota,
  });
  return { scheduler, calls, rpcCalls };
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

// ---------------------------------------------------------------------------
// 自动发现 与 额度闸门 的顺序回归
//
// tick() 里 maybeDiscover() 必须排在额度闸门**之前**。否则额度 exhausted 时
// tick 早在闸门处 return 了，而「被额度打断」恰恰就发生在那个状态里 ——
// 功能会在自己注释点名的场景下静默失效（且单元测试全是 available，看不出来）。
// ---------------------------------------------------------------------------

const QUOTA_DEAD_TURNS = [
  { id: "t1", status: "failed", error: { codexErrorInfo: "usageLimitExceeded", message: "usage limit reached" } },
];

const EXHAUSTED_QUOTA = {
  status: "exhausted",
  blockingBuckets: ["codex"],
  resetCreditsAvailable: 0,
} as unknown as QuotaSnapshot;

/** 应答 thread/list + thread/read，返回一条「最后一个 turn 死于额度」的会话 */
function makeDiscoveryClient(cwd: string, threadId = "thread-interrupted"): AppServerClient {
  return {
    isHealthy: () => true,
    async request(method: string) {
      if (method === "thread/list") {
        return {
          data: [{ id: threadId, cwd, updatedAt: Date.now(), status: { type: "idle" }, name: "interrupted session" }],
        };
      }
      if (method === "thread/read") return { thread: { turns: QUOTA_DEAD_TURNS } };
      throw new Error("unexpected rpc in scheduler test: " + method);
    },
  } as unknown as AppServerClient;
}

test("discovery: an exhausted bucket still gets its sessions scanned and queued", async () => {
  const { repo, project } = setup();
  const { scheduler, rpcCalls } = makeScheduler(repo, {
    client: makeDiscoveryClient(project),
    quota: EXHAUSTED_QUOTA,
  });
  await scheduler.tick();

  assert.ok(
    rpcCalls.includes("thread/list"),
    "discovery must run before the quota gate returns early",
  );
  const adopted = repo.listTasks().filter((t) => t.title.startsWith("Auto-resume:"));
  assert.equal(adopted.length, 1, "the quota-interrupted session should be queued even while blocked");
  assert.equal(adopted[0].status, "READY", "a discovered task is claimable the moment quota returns");
  assert.equal(adopted[0].mode, "resume_thread");
  assert.equal(adopted[0].threadId, "thread-interrupted");
  repo.close();
});

test("quota gate: an exhausted bucket still refuses to run an already-queued task", async () => {
  const { repo, project } = setup();
  const t = repo.createTask({
    title: "queued while blocked", projectPath: project, originalGoal: "g", priority: 50,
  });

  const { scheduler, calls } = makeScheduler(repo, { quota: EXHAUSTED_QUOTA });
  await scheduler.tick();

  assert.deepEqual(calls, [], "must not burn quota on a turn while the bucket is exhausted");
  assert.equal(repo.getTask(t.id)?.status, "READY", "stays queued for the recovery tick");
  repo.close();
});

test("discovery: a failing scan must not break the scheduling loop", async () => {
  const { repo, project } = setup();
  const t = repo.createTask({
    title: "still runs", projectPath: project, originalGoal: "g", priority: 50,
  });

  // 默认替身对任何 RPC 都抛错 —— 发现扫描会撞上它，但 tick 必须照常走到 claim
  const { scheduler, calls } = makeScheduler(repo);
  await scheduler.tick();

  assert.deepEqual(calls, [t.id], "discovery errors are swallowed; the task still runs");
  repo.close();
});

// ---------------------------------------------------------------------------
// git 闸门 与 续跑任务
//
// prepareForRun 默认要求工作区干净，这对 resume_thread 任务是语义错位：它要回到线程
// **自己的工作区**接着干，那里有未提交改动是常态（往往就是它自己被打断时留下的）。
// 实测桌面端那条任务就因此停在 WAITING_USER（last_error: 工作区不干净；需要显式授权），
// 连 resume / fork 都没走到。这里用真 git 仓库验两侧：放行续跑，且没有顺手把闸门拆了。
// ---------------------------------------------------------------------------

/** 造一个真 git 仓库并弄脏它；返回是否成功（无 git 则用例跳过） */
function initDirtyGitRepo(dir: string): boolean {
  const opts = { cwd: dir, windowsHide: true, encoding: "utf8" as const };
  if ((spawnSync("git", ["init", "-q"], opts).status ?? -1) !== 0) return false;
  writeFileSync(join(dir, "wip.txt"), "uncommitted work\n");
  const st = spawnSync("git", ["status", "--porcelain=v1"], opts);
  return (st.status ?? -1) === 0 && (st.stdout ?? "").includes("wip.txt");
}

test("git guard: a resumed thread is let back into its own dirty workspace", async (t) => {
  const { repo } = setup();
  const project = makeProject();
  if (!initDirtyGitRepo(project)) {
    t.skip("git unavailable");
    return;
  }
  const task = repo.createTask({
    title: "resume into a dirty tree", projectPath: project, originalGoal: "g", priority: 50,
    mode: "resume_thread", threadId: "th-dirty", sandboxMode: "workspaceWrite",
  });

  const { scheduler, calls } = makeScheduler(repo);
  await scheduler.tick();

  assert.deepEqual(calls, [task.id], "the git guard must not park a resumed thread");
  assert.notEqual(repo.getTask(task.id)?.status, "WAITING_USER");
  repo.close();
});

test("git guard: a brand-new write task is still parked on a dirty workspace", async (t) => {
  const { repo } = setup();
  const project = makeProject();
  if (!initDirtyGitRepo(project)) {
    t.skip("git unavailable");
    return;
  }
  const task = repo.createTask({
    title: "fresh write task", projectPath: project, originalGoal: "g", priority: 50,
    mode: "new_thread", sandboxMode: "workspaceWrite",
  });

  const { scheduler, calls } = makeScheduler(repo);
  await scheduler.tick();

  assert.deepEqual(calls, [], "a new write task must still wait for a clean tree");
  assert.equal(repo.getTask(task.id)?.status, "WAITING_USER");
  assert.ok(repo.getTask(task.id)?.lastError?.includes("工作区不干净"), "keeps the original reason");
  repo.close();
});

after(() => {
  for (const dir of createdProjects) rmSync(dir, { recursive: true, force: true });
});
