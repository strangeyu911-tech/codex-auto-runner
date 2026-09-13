import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteRepository } from "../src/repository.js";
import { canTransition, canPauseTransition, TERMINAL_STATUSES } from "../src/types.js";

let repo: SqliteRepository;
function fresh() {
  repo = new SqliteRepository(":memory:");
  repo.migrate();
  return repo;
}

test("state machine: full happy path", () => {
  assert.equal(canTransition("DRAFT", "READY"), true);
  assert.equal(canTransition("READY", "PREPARING"), true);
  assert.equal(canTransition("PREPARING", "STARTING_THREAD"), true);
  assert.equal(canTransition("STARTING_THREAD", "RUNNING"), true);
  assert.equal(canTransition("RUNNING", "VERIFYING"), true);
  assert.equal(canTransition("VERIFYING", "COMPLETED"), true);
  assert.equal(canTransition("RUNNING", "COMPLETED"), false);
});

test("state machine: WAITING_QUOTA -> READY", () => {
  assert.equal(canTransition("WAITING_QUOTA", "READY"), true);
});

test("state machine: pause semantics", () => {
  assert.equal(canPauseTransition("RUNNING"), true);
  assert.equal(canPauseTransition("COMPLETED"), false);
  assert.equal(canPauseTransition("FAILED_FINAL"), false);
  assert.equal(canPauseTransition("PAUSED"), false);
});

test("state machine: terminal set", () => {
  assert.ok(TERMINAL_STATUSES.has("COMPLETED"));
  assert.ok(!TERMINAL_STATUSES.has("RUNNING"));
});

test("repository: createTask + get + list", () => {
  const r = fresh();
  const t = r.createTask({ title: "T1", projectPath: "D:\\proj", originalGoal: "do thing", priority: 75 });
  assert.equal(r.getTask(t.id)?.title, "T1");
  assert.equal(r.getTask(t.id)?.status, "READY");
  assert.equal(r.listTasks().length, 1);
  r.close();
});

test("repository: claimNextRunnable selects highest priority + single concurrency", () => {
  const r = fresh();
  r.createTask({ title: "low", projectPath: "D:\\p1", originalGoal: "g", priority: 10 });
  r.createTask({ title: "high", projectPath: "D:\\p2", originalGoal: "g", priority: 80 });
  const claimed = r.claimNextRunnable();
  assert.equal(claimed?.title, "high");
  assert.equal(claimed?.status, "PREPARING");
  assert.equal(r.claimNextRunnable(), undefined);
  r.close();
});

test("repository: transitionInTx blocks illegal transitions", () => {
  const r = fresh();
  const t = r.createTask({ title: "T", projectPath: "D:\\p", originalGoal: "g" });
  assert.equal(r.transitionInTx(t.id, "READY", "RUNNING"), false);
  assert.equal(r.getTask(t.id)?.status, "READY");
  assert.equal(r.transitionInTx(t.id, "READY", "PREPARING"), true);
  r.close();
});

test("repository: project lock acquire/release", () => {
  const r = fresh();
  const t1 = r.createTask({ title: "T", projectPath: "D:\\p", originalGoal: "g" });
  const t2 = r.createTask({ title: "T2", projectPath: "D:\\p", originalGoal: "g" });
  assert.equal(r.acquireProjectLock("D:\\p", t1.id, null), true);
  assert.equal(r.acquireProjectLock("D:\\p", t2.id, null), false);
  assert.equal(r.isProjectLocked("D:\\p"), true);
  r.releaseProjectLock("D:\\p");
  assert.equal(r.isProjectLocked("D:\\p"), false);
  assert.equal(r.acquireProjectLock("D:\\p", t2.id, null), true);
  r.close();
});

test("repository: patch writes whitelisted columns", () => {
  const r = fresh();
  const t = r.createTask({ title: "T", projectPath: "D:\\p", originalGoal: "g" });
  r.patch(t.id, { threadId: "th-123", runCycleCount: 2 });
  const got = r.getTask(t.id);
  assert.equal(got?.threadId, "th-123");
  assert.equal(got?.runCycleCount, 2);
  r.close();
});

test("repository: scanAbnormalRunning marks RECOVERING", () => {
  const r = fresh();
  const t = r.createTask({ title: "T", projectPath: "D:\\p", originalGoal: "g" });
  r.forceStatus(t.id, "RUNNING");
  const abn = r.scanAbnormalRunning();
  assert.equal(abn.length, 1);
  assert.equal(r.getTask(t.id)?.status, "RECOVERING");
  r.close();
});

test("repository: thread unique constraint", () => {
  const r = fresh();
  r.createTask({ title: "T", projectPath: "D:\\p", originalGoal: "g", threadId: "THX" });
  assert.throws(() => r.createTask({ title: "T2", projectPath: "D:\\p2", originalGoal: "g", threadId: "THX" }));
  r.close();
});

/* ------------------------------------------------------------------ *
 * 5h 限额续跑：数据模型 + 调度选取
 * ------------------------------------------------------------------ */

test("quota: new columns are migrated and default to null", () => {
  const r = fresh();
  const t = r.createTask({ title: "T", projectPath: "D:\\p", originalGoal: "g" });
  assert.equal(t.lastQuotaInterruptedAt, null);
  assert.equal(t.lastQuotaInterruptedThreadId, null);
  const got = r.getTask(t.id);
  assert.equal(got?.lastQuotaInterruptedAt, null);
  assert.equal(got?.lastQuotaInterruptedThreadId, null);
  r.close();
});

test("quota: patch() can persist the interrupted thread + time", () => {
  const r = fresh();
  const t = r.createTask({ title: "T", projectPath: "D:\\p", originalGoal: "g" });
  r.patch(t.id, { lastQuotaInterruptedAt: 1700000000000, lastQuotaInterruptedThreadId: "th-quota" });
  const got = r.getTask(t.id);
  assert.equal(got?.lastQuotaInterruptedAt, 1700000000000);
  assert.equal(got?.lastQuotaInterruptedThreadId, "th-quota");
  r.close();
});

test("quota: migration is idempotent (migrate() twice)", () => {
  const r = fresh();
  const t = r.createTask({ title: "T", projectPath: "D:\\p", originalGoal: "g" });
  r.migrate(); // 第二次调用不应因为列已存在而抛错
  r.patch(t.id, { lastQuotaInterruptedAt: 123, lastQuotaInterruptedThreadId: "th-x" });
  assert.equal(r.getTask(t.id)?.lastQuotaInterruptedThreadId, "th-x");
  r.close();
});

test("quota: listQuotaInterruptedThreads indexes threadId -> latest time", () => {
  const r = fresh();
  const a = r.createTask({ title: "A", projectPath: "D:\\p1", originalGoal: "g" });
  const b = r.createTask({ title: "B", projectPath: "D:\\p2", originalGoal: "g" });
  r.patch(a.id, { lastQuotaInterruptedAt: 1000, lastQuotaInterruptedThreadId: "th-A" });
  r.patch(b.id, { lastQuotaInterruptedAt: 2000, lastQuotaInterruptedThreadId: "th-B" });
  const idx = r.listQuotaInterruptedThreads();
  assert.equal(idx.get("th-A"), 1000);
  assert.equal(idx.get("th-B"), 2000);
  assert.equal(idx.size, 2);
  r.close();
});

test("quota: claimNextRunnable prefers the most recently interrupted task", () => {
  const r = fresh();
  // 两条任务同优先级，都没有 nextRunAt：只有「被额度打断」的那条应被先认领
  const plain = r.createTask({ title: "plain", projectPath: "D:\\p1", originalGoal: "g", priority: 50 });
  const interrupted = r.createTask({ title: "interrupted", projectPath: "D:\\p2", originalGoal: "g", priority: 50 });
  r.patch(interrupted.id, { lastQuotaInterruptedAt: 5000, lastQuotaInterruptedThreadId: "th-i" });

  const claimed = r.claimNextRunnable();
  assert.equal(claimed?.title, "interrupted", "被额度打断的任务应优先认领");
  assert.equal(r.getTask(plain.id)?.status, "READY", "普通任务应保持 READY 未被认领");
  r.close();
});

test("quota: among two interrupted tasks, the latest one wins", () => {
  const r = fresh();
  const older = r.createTask({ title: "older", projectPath: "D:\\p1", originalGoal: "g", priority: 50 });
  const newer = r.createTask({ title: "newer", projectPath: "D:\\p2", originalGoal: "g", priority: 50 });
  r.patch(older.id, { lastQuotaInterruptedAt: 1000, lastQuotaInterruptedThreadId: "th-old" });
  r.patch(newer.id, { lastQuotaInterruptedAt: 9000, lastQuotaInterruptedThreadId: "th-new" });

  const claimed = r.claimNextRunnable();
  assert.equal(claimed?.title, "newer", "应优先续跑最新的那条被中断线程");
  r.close();
});

test("quota: explicit priority still outranks the interrupted bonus", () => {
  const r = fresh();
  const hi = r.createTask({ title: "hi", projectPath: "D:\\p1", originalGoal: "g", priority: 90 });
  const interrupted = r.createTask({ title: "interrupted", projectPath: "D:\\p2", originalGoal: "g", priority: 50 });
  r.patch(interrupted.id, { lastQuotaInterruptedAt: 9000, lastQuotaInterruptedThreadId: "th-i" });

  const claimed = r.claimNextRunnable();
  assert.equal(claimed?.title, "hi", "用户显式设置的高优先级仍然优先");
  r.close();
});

test("quota: findLatestQuotaInterruptedTask skips terminal tasks", () => {
  const r = fresh();
  const done = r.createTask({ title: "done", projectPath: "D:\\p1", originalGoal: "g" });
  const live = r.createTask({ title: "live", projectPath: "D:\\p2", originalGoal: "g" });
  r.patch(done.id, { lastQuotaInterruptedAt: 9000, lastQuotaInterruptedThreadId: "th-done" });
  r.patch(live.id, { lastQuotaInterruptedAt: 1000, lastQuotaInterruptedThreadId: "th-live" });
  r.forceStatus(done.id, "COMPLETED");

  const found = r.findLatestQuotaInterruptedTask();
  assert.equal(found?.title, "live", "已终态的任务不应被选为恢复目标");
  r.close();
});

test("quota: lastRunQuotaExhausted reflects task_runs.quota_exhausted", () => {
  const r = fresh();
  const t = r.createTask({ title: "T", projectPath: "D:\\p", originalGoal: "g" });
  assert.equal(r.lastRunQuotaExhausted(t.id), false, "无 run 记录时应为 false");

  r.insertRun("run_1", t.id, "turn_1", "RUNNING");
  r.finishRun("run_1", "quota_exhausted", null, "usage limit", 1);
  assert.equal(r.lastRunQuotaExhausted(t.id), true);

  r.insertRun("run_2", t.id, "turn_2", "RUNNING");
  r.finishRun("run_2", "completed", "{}", null, 0);
  assert.equal(r.lastRunQuotaExhausted(t.id), false, "应只看最近一次 run");
  r.close();
});

test("quota: an interrupted thread with NO goal is still identifiable", () => {
  // 这是用户诉求的核心：无 goal 线程必须同样能被选中续跑。
  // 这里用一个「没有 goal 概念」的纯 resume_thread 任务验证：
  // 只要 lastQuotaInterruptedThreadId 有值，就会被索引到并优先认领。
  const r = fresh();
  const t = r.createTask({
    title: "no-goal",
    projectPath: "D:\\p",
    originalGoal: "g",
    mode: "resume_thread",
    threadId: "th-no-goal",
  });
  r.patch(t.id, { lastQuotaInterruptedAt: 7777, lastQuotaInterruptedThreadId: "th-no-goal" });

  const idx = r.listQuotaInterruptedThreads();
  assert.equal(idx.get("th-no-goal"), 7777, "无 goal 线程同样进入被打断索引");

  // 模拟额度恢复：WAITING_QUOTA -> READY -> 被认领
  r.forceStatus(t.id, "WAITING_QUOTA");
  assert.equal(r.getTask(t.id)?.status, "WAITING_QUOTA");
  assert.equal(r.claimNextRunnable(), undefined, "WAITING_QUOTA 不可直接认领");

  r.forceStatus(t.id, "READY");
  r.patch(t.id, { nextRunAt: null });
  const claimed = r.claimNextRunnable();
  assert.equal(claimed?.id, t.id);
  assert.equal(claimed?.lastQuotaInterruptedThreadId, "th-no-goal", "续跑时应保留线程绑定");
  r.close();
});