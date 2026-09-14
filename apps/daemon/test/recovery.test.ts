/**
 * 进程重启后的任务恢复验收。
 *
 * 这是「撞 5h 后不用醒来」在 CAR 自己这一侧的收口：老行为把重启时还挂在 RUNNING 的任务
 * 一律判成 WAITING_USER，用户必须手动点一次；新行为读线程的 turn 历史，
 * 把「被掐断」和「其实跑完了」分开，前者直接放回队列。
 *
 * 用真实的 SqliteRepository（内存库），只把 app-server 用替身顶掉，
 * 因此 createTask / forceStatus / patch / appendEvent 走的都是真实实现。
 *
 * 运行：tsx --test apps/daemon/test/recovery.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SqliteRepository } from "@car/persistence";
import { createLogger } from "@car/logger";
import type { AppServerClient } from "@car/app-server-client";
import { RECOVERY_NEEDS_CONFIRM } from "@car/task-engine";
import { recoverInterruptedTasks } from "../src/recovery.js";

const THREAD = "01a09bc3-dff2-78a3-9b97-f12797f07007";

/** 只应答 thread/read 的替身；值给 "throw" 表示读取失败 */
function makeClient(byThread: Record<string, unknown[] | "throw" | null>) {
  return {
    async request(method: string, params?: Record<string, unknown>) {
      if (method !== "thread/read") throw new Error("unexpected rpc in recovery test: " + method);
      const id = String(params?.threadId);
      if (!(id in byThread)) throw new Error("no fixture for thread " + id);
      const v = byThread[id];
      if (v === "throw") throw new Error("thread/read exploded");
      if (v === null) return { thread: null };
      return { thread: { turns: v } };
    },
  } as unknown as AppServerClient;
}

const deps = (repo: SqliteRepository, byThread: Record<string, unknown[] | "throw" | null>) => ({
  client: makeClient(byThread),
  repo,
  logger: createLogger({ level: "error" }),
});

function setup(): SqliteRepository {
  const repo = new SqliteRepository(":memory:");
  repo.migrate();
  return repo;
}

/** 造一个「上个进程死在 RUNNING」的任务，并走真实的 scanAbnormalRunning() */
function crashTask(repo: SqliteRepository, over: { threadId?: string | null } = {}) {
  const t = repo.createTask({
    title: "crashed mid-run",
    projectPath: "C:\\tmp\\somewhere",
    originalGoal: "g",
    mode: "resume_thread",
    threadId: over.threadId === undefined ? THREAD : over.threadId,
    priority: 100,
  });
  repo.forceStatus(t.id, "RUNNING");
  const abnormal = repo.scanAbnormalRunning(); // RUNNING → RECOVERING，并返回
  return { task: t, abnormal };
}

const methods = (repo: SqliteRepository, id: string) => repo.listEvents({ taskId: id }).map((e) => e.method);

test("recovery: an interrupted last turn is queued to resume instead of waiting for the user", async () => {
  const repo = setup();
  const { task, abnormal } = crashTask(repo);

  const out = await recoverInterruptedTasks(
    deps(repo, { [THREAD]: [{ id: "t1", status: "failed" }, { id: "t2", status: "interrupted" }] }),
    abnormal,
  );

  assert.deepEqual(out.resumed, [task.id]);
  const after = repo.getTask(task.id);
  assert.equal(after?.status, "READY", "cut-off run must go back to the queue");
  assert.equal(after?.lastError, null);
  assert.ok(typeof after?.nextRunAt === "number", "nextRunAt must be set so the claim is not blocked");
  assert.ok(methods(repo, task.id).includes("recover/resumed-cut-off"));
  repo.close();
});

test("recovery: a completed last turn still parks for the user", async () => {
  const repo = setup();
  const { task, abnormal } = crashTask(repo);

  const out = await recoverInterruptedTasks(
    deps(repo, { [THREAD]: [{ id: "t1", status: "completed" }] }),
    abnormal,
  );

  assert.deepEqual(out.parked, [task.id]);
  const after = repo.getTask(task.id);
  assert.equal(after?.status, "WAITING_USER", "the agent may be waiting for a human");
  assert.equal(after?.lastError, RECOVERY_NEEDS_CONFIRM);
  assert.ok(methods(repo, task.id).includes("recover/parked"));
  repo.close();
});

test("recovery: a recorded quota hit keeps its quota semantics", async () => {
  const repo = setup();
  const { task, abnormal } = crashTask(repo);
  repo.patch(task.id, { lastQuotaInterruptedAt: Date.now() });

  const out = await recoverInterruptedTasks(
    deps(repo, { [THREAD]: [{ id: "t1", status: "interrupted" }] }),
    abnormal,
  );

  assert.deepEqual(out.quotaDeferred, [task.id]);
  assert.deepEqual(out.resumed, [], "quota semantics win over an immediate resume");
  assert.equal(repo.getTask(task.id)?.status, "WAITING_QUOTA");
  repo.close();
});

test("recovery: an unreadable thread fails closed", async () => {
  const repo = setup();
  const { task, abnormal } = crashTask(repo);

  const out = await recoverInterruptedTasks(deps(repo, { [THREAD]: "throw" }), abnormal);

  assert.deepEqual(out.parked, [task.id]);
  assert.equal(repo.getTask(task.id)?.status, "WAITING_USER");
  assert.equal(repo.getTask(task.id)?.lastError, RECOVERY_NEEDS_CONFIRM);
  repo.close();
});

test("recovery: a task with no thread at all fails closed", async () => {
  const repo = setup();
  const { task, abnormal } = crashTask(repo, { threadId: null });

  const out = await recoverInterruptedTasks(deps(repo, {}), abnormal);

  assert.deepEqual(out.parked, [task.id]);
  assert.equal(repo.getTask(task.id)?.status, "WAITING_USER");
  repo.close();
});

test("reclaim: a task the OLD code parked by mistake is dug back out", async () => {
  const repo = setup();
  // 复现历史遗留：任务被老逻辑停成 WAITING_USER + 那个专用标记（旧版本没有恢复判定）
  const t = repo.createTask({
    title: "parked by the old recovery scan",
    projectPath: "C:\\tmp\\somewhere",
    originalGoal: "g",
    mode: "resume_thread",
    threadId: THREAD,
    priority: 100,
  });
  repo.forceStatus(t.id, "WAITING_USER");
  repo.patch(t.id, { lastError: RECOVERY_NEEDS_CONFIRM });

  const out = await recoverInterruptedTasks(
    deps(repo, { [THREAD]: [{ id: "t1", status: "interrupted" }] }),
    [],
  );

  assert.deepEqual(out.reclaimed, [t.id], "legacy park should be reclaimed");
  assert.deepEqual(out.resumed, [t.id]);
  assert.equal(repo.getTask(t.id)?.status, "READY");
  assert.ok(methods(repo, t.id).includes("recover/reclaimed"));
  repo.close();
});

test("reclaim: a legacy park whose work actually finished stays put", async () => {
  const repo = setup();
  const t = repo.createTask({
    title: "parked by the old recovery scan",
    projectPath: "C:\\tmp\\somewhere",
    originalGoal: "g",
    mode: "resume_thread",
    threadId: THREAD,
    priority: 100,
  });
  repo.forceStatus(t.id, "WAITING_USER");
  repo.patch(t.id, { lastError: RECOVERY_NEEDS_CONFIRM });

  const out = await recoverInterruptedTasks(
    deps(repo, { [THREAD]: [{ id: "t1", status: "completed" }] }),
    [],
  );

  assert.deepEqual(out.reclaimed, []);
  assert.deepEqual(out.parked, [t.id]);
  assert.equal(repo.getTask(t.id)?.status, "WAITING_USER", "idempotent: still waiting for the user");
  repo.close();
});

test("reclaim: a WAITING_USER task parked for some OTHER reason is never touched", async () => {
  const repo = setup();
  const t = repo.createTask({
    title: "the agent asked for a human",
    projectPath: "C:\\tmp\\somewhere",
    originalGoal: "g",
    mode: "resume_thread",
    threadId: THREAD,
    priority: 100,
  });
  repo.forceStatus(t.id, "WAITING_USER");
  repo.patch(t.id, { lastError: "needs_user" });

  const out = await recoverInterruptedTasks(
    deps(repo, { [THREAD]: [{ id: "t1", status: "interrupted" }] }),
    [],
  );

  assert.equal(out.examined, 0, "only the recovery marker makes a park reclaimable");
  assert.equal(repo.getTask(t.id)?.status, "WAITING_USER");
  assert.deepEqual(methods(repo, t.id), []);
  repo.close();
});
