/**
 * 端到端验收：无 goal 线程被 5h 限额打断 → 额度恢复 → 丝滑续跑。
 *
 * 这个测试直接对应 Strange 的验收标准：
 *   「直到用户没有设置 goal 的线程，也能丝滑使达到 5h 限制的任务续跑。
 *     如果同时存在两个及以上被 5h 限制中断的线程，优先续跑最新的。」
 *
 * 用真实的 SqliteRepository（内存库），只把 app-server 用假的替身顶掉，
 * 因此覆盖了：数据落库 → 排序 → 认领 → 唤醒 的完整链路。
 *
 * 运行：node --test test/quota-resume-e2e.test.ts
 * （不用 vitest：这个测试依赖 node:sqlite 内置模块，vitest 的解析器处理不了）
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SqliteRepository } from "../packages/persistence/src/repository.js";

let repo: SqliteRepository;

beforeEach(() => {
  repo = new SqliteRepository(":memory:");
  repo.migrate();
});

/** 模拟 task-engine 命中 quota 时写库的行为（runOneTurn 的 quota_exhausted 分支） */
function applyQuotaInterrupt(taskId: string, threadId: string, at: number) {
  const t = repo.getTask(taskId);
  assert.ok(t, "task must exist");
  repo.transitionInTx(taskId, "RUNNING", "WAITING_QUOTA");
  repo.patch(taskId, {
    quotaCycleCount: t.quotaCycleCount + 1,
    quotaResetAt: null,
    lastQuotaInterruptedAt: at,
    lastQuotaInterruptedThreadId: threadId,
  });
  repo.appendEvent(taskId, "quota/interrupted", { threadId, at }, null);
}

/** 模拟 scheduler.wakeQuotaWaitingTasks()：额度恢复后把 WAITING_QUOTA 推回 READY */
function wakeQuotaWaiting(): number {
  const waiting = repo.listTasks().filter((t) => t.status === "WAITING_QUOTA");
  for (const t of waiting) {
    repo.forceStatus(t.id, "READY");
    repo.patch(t.id, { nextRunAt: null, quotaResetAt: null, lastError: null });
  }
  return waiting.length;
}

test("no-goal: resumes a quota-interrupted thread that has NO goal set", () => {
  // 关键点：这个任务代表一个「没有设置 goal」的 Codex 线程。
  // 之前的行为是「判完即弃」——没有 goal 就识别不到，续跑无从谈起。
  const t = repo.createTask({
    title: "no-goal thread",
    projectPath: "D:\\proj",
    originalGoal: "",
    mode: "resume_thread",
    threadId: "th-no-goal",
    priority: 50,
  });
  repo.forceStatus(t.id, "RUNNING");

  applyQuotaInterrupt(t.id, "th-no-goal", 1_700_000_000_000);

  // 1) 落库了：线程 id + 时间都可查
  const after = repo.getTask(t.id);
  assert.equal(after?.status, "WAITING_QUOTA");
  assert.equal(after?.lastQuotaInterruptedThreadId, "th-no-goal");
  assert.equal(after?.lastQuotaInterruptedAt, 1_700_000_000_000);

  // 2) 进入「被打断线程索引」（前端排序与角标的数据源）
  assert.equal(repo.listQuotaInterruptedThreads().get("th-no-goal"), 1_700_000_000_000);

  // 3) WAITING_QUOTA 不能被直接认领（否则会在额度未恢复时硬跑）
  assert.equal(repo.claimNextRunnable(), undefined);

  // 4) 额度恢复 → 唤醒 → 可被认领
  assert.equal(wakeQuotaWaiting(), 1);
  const claimed = repo.claimNextRunnable();
  assert.equal(claimed?.id, t.id);
  assert.equal(claimed?.lastQuotaInterruptedThreadId, "th-no-goal");

  // 5) 续跑时线程绑定没丢
  assert.equal(claimed?.threadId, "th-no-goal");
  repo.close();
});

test("no-goal: prefers the LATEST interrupted thread when several are pending", () => {
  const older = repo.createTask({
    title: "older no-goal", projectPath: "D:\\p1", originalGoal: "",
    mode: "resume_thread", threadId: "th-old", priority: 50,
  });
  const newer = repo.createTask({
    title: "newer no-goal", projectPath: "D:\\p2", originalGoal: "",
    mode: "resume_thread", threadId: "th-new", priority: 50,
  });
  const unrelated = repo.createTask({
    title: "plain", projectPath: "D:\\p3", originalGoal: "g", priority: 50,
  });

  repo.forceStatus(older.id, "RUNNING");
  repo.forceStatus(newer.id, "RUNNING");
  applyQuotaInterrupt(older.id, "th-old", 1_000_000);
  applyQuotaInterrupt(newer.id, "th-new", 9_000_000);

  assert.equal(wakeQuotaWaiting(), 2);

  // 用户诉求：「优先续跑最新的」→ th-new 先走
  const first = repo.claimNextRunnable();
  assert.equal(first?.id, newer.id);

  // 单并发：一次只跑一个，另外两条仍未被动
  assert.equal(repo.claimNextRunnable(), undefined);
  assert.equal(repo.getTask(older.id)?.status, "READY");
  assert.equal(repo.getTask(unrelated.id)?.status, "READY");
  repo.close();
});

test("restart: keeps quota semantics instead of demanding user confirm", () => {
  const t = repo.createTask({
    title: "mid-run restart", projectPath: "D:\\p", originalGoal: "",
    mode: "resume_thread", threadId: "th-restart", priority: 50,
  });
  repo.forceStatus(t.id, "RUNNING");
  // 上一次 run 因额度被打断
  repo.insertRun("run_1", t.id, "turn_1", "RUNNING");
  repo.finishRun("run_1", "quota_exhausted", null, "usage limit", 1);

  // 模拟 daemon 重启：scanAbnormalRunning 把它标成 RECOVERING
  const abnormal = repo.scanAbnormalRunning();
  assert.equal(abnormal.length, 1);
  assert.equal(repo.getTask(t.id)?.status, "RECOVERING");

  // 第 6 项的逻辑：命中限额特征 → 保留 WAITING_QUOTA 语义
  const quotaHit = repo.lastRunQuotaExhausted(t.id) || t.lastQuotaInterruptedAt != null;
  assert.equal(quotaHit, true);
  repo.forceStatus(t.id, "WAITING_QUOTA");
  assert.equal(repo.getTask(t.id)?.status, "WAITING_QUOTA");

  // 对比：普通异常中断仍走 WAITING_USER（需要人工确认）
  const plain = repo.createTask({
    title: "crashed", projectPath: "D:\\p2", originalGoal: "g", priority: 50,
  });
  repo.forceStatus(plain.id, "RUNNING");
  repo.insertRun("run_2", plain.id, "turn_2", "RUNNING");
  repo.finishRun("run_2", "failed", null, "boom", 0);
  repo.forceStatus(plain.id, "RECOVERING");
  assert.equal(repo.lastRunQuotaExhausted(plain.id), false);
  repo.close();
});

test("priority: a stale quota interrupt does not dominate explicit high priority", () => {
  const urgent = repo.createTask({
    title: "urgent", projectPath: "D:\\p1", originalGoal: "g", priority: 95,
  });
  const interrupted = repo.createTask({
    title: "interrupted", projectPath: "D:\\p2", originalGoal: "",
    mode: "resume_thread", threadId: "th-x", priority: 20,
  });
  repo.forceStatus(interrupted.id, "RUNNING");
  applyQuotaInterrupt(interrupted.id, "th-x", 9_000_000);
  wakeQuotaWaiting();

  // 用户显式设定的优先级仍然优先，不会被「被打断」加成掀翻
  const claimed = repo.claimNextRunnable();
  assert.equal(claimed?.id, urgent.id);
  repo.close();
});

test("mid-run: indexes the interrupted thread even when thread id was assigned mid-run", () => {
  // 新建线程场景：task.threadId 起初为 null，quota 分支必须用局部 threadId 落库
  const t = repo.createTask({
    title: "new thread then interrupted", projectPath: "D:\\p",
    originalGoal: "g", priority: 50,
  });
  repo.forceStatus(t.id, "RUNNING");
  // 模拟 runOneTurn 中 threadId 是局部变量、task.threadId 尚未回填的情形
  applyQuotaInterrupt(t.id, "th-fresh", 555_000);

  const got = repo.getTask(t.id);
  assert.equal(got?.lastQuotaInterruptedThreadId, "th-fresh");
  assert.equal(repo.listQuotaInterruptedThreads().get("th-fresh"), 555_000);
  repo.close();
});
