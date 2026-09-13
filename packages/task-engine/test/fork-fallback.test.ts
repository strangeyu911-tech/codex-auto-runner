import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import type { ManagedTask } from "@car/persistence";
import { TaskEngine } from "../src/index.js";

/**
 * writer conflict 降级 fork 的回归测试。
 *
 * 背景：桌面版与 CAR 各跑自己的 app-server、共享 `~/.codex`，而一条线程同一时刻
 * 只能有一个 writer。桌面版是常驻进程，它开过的线程在撞限额后不会释放写锁，
 * 于是 CAR 的 `thread/resume` 必然撞 `already has an active writer`。
 *
 * 解法：仅在该冲突下改用 `thread/fork` —— 从父线程派生一条**归本 client 所有**的
 * 新线程继续跑（父锁不动）。本文件锁住这条链路的五个边界，避免它退化成
 * 「任何 resume 失败都 fork」的万能兜底，或反复产出孤儿线程。
 *
 * 刻意不使用真仓库：node:sqlite 在 vitest 的解析器下不可用，且这层逻辑本就
 * 与 SQLite 无关。持久化字段的正确性由 packages/persistence 自己的测试覆盖。
 */

/* ----------------------------- 测试替身 ----------------------------- */

type Call = { method: string; params: Record<string, unknown> };

/** 只记录调用、按注册的 handler 应答的 app-server 替身 */
class FakeClient extends EventEmitter {
  readonly calls: Call[] = [];
  private readonly handlers = new Map<string, (params: Record<string, unknown>) => unknown>();

  /** 注册某方法的成功应答 */
  onMethod(method: string, fn: (params: Record<string, unknown>) => unknown): void {
    this.handlers.set(method, fn);
  }

  /** 注册某方法的失败应答 */
  fail(method: string, message: string): void {
    this.onMethod(method, () => {
      throw new Error(message);
    });
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params: params ?? {} });
    const handler = this.handlers.get(method);
    // 未注册 = 该方法不该被调用，直接失败以便测试暴露多余的 RPC
    if (!handler) throw new Error(`FakeClient: unexpected method ${method}`);
    return await handler(params ?? {});
  }

  async forkThread(parentThreadId: string, params?: Record<string, unknown>): Promise<string> {
    const resp = (await this.request("thread/fork", {
      threadId: parentThreadId,
      excludeTurns: true,
      ...params,
    })) as { thread?: { id?: string } } | null;
    const id = resp?.thread?.id;
    if (!id) throw new Error("thread/fork returned no thread.id");
    return id;
  }

  callsOf(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }
}

/** 内存版任务仓库，只实现 TaskEngine 用到的方法 */
class FakeRepo {
  readonly tasks = new Map<string, ManagedTask>();
  readonly patches: Array<{ id: string; fields: Partial<ManagedTask> }> = [];
  readonly events: Array<{ taskId: string | null; type: string; payload: unknown }> = [];
  readonly transitions: Array<{ id: string; from: string; to: string }> = [];
  readonly runs: Array<{ runId: string; taskId: string; turnId: string }> = [];

  constructor(seed: ManagedTask) {
    this.tasks.set(seed.id, { ...seed });
  }

  getTask(id: string): ManagedTask | undefined {
    const t = this.tasks.get(id);
    return t ? { ...t } : undefined;
  }

  patch(id: string, fields: Partial<ManagedTask>): void {
    this.patches.push({ id, fields });
    const t = this.tasks.get(id);
    if (t) Object.assign(t, fields);
  }

  transitionInTx(id: string, from: string, to: string): boolean {
    this.transitions.push({ id, from, to });
    const t = this.tasks.get(id);
    if (t) t.status = to as ManagedTask["status"];
    return true;
  }

  appendEvent(taskId: string | null, type: string, payload: unknown): void {
    this.events.push({ taskId, type, payload });
  }

  insertRun(runId: string, taskId: string, turnId: string): void {
    this.runs.push({ runId, taskId, turnId });
  }
}

const silentLogger = {
  level: "silent",
  child() { return silentLogger; },
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

function makeTask(overrides: Partial<ManagedTask> = {}): ManagedTask {
  const now = Date.now();
  return {
    id: "task-1",
    title: "fixture",
    mode: "resume_thread",
    projectPath: tmpdir(),
    threadId: "parent-1",
    sessionId: "parent-1",
    originalGoal: "keep the build green",
    resumeInstruction: "continue from where you left off",
    acceptanceCriteria: [],
    priority: 50,
    status: "PREPARING",
    model: null,
    sandboxMode: "readOnly",
    networkAccess: false,
    approvalMode: "safe_autonomous",
    workspaceMode: "direct",
    branchName: null,
    worktreePath: null,
    validationCommands: [],
    maxRunCycles: 5,
    runCycleCount: 0,
    maxQuotaCycles: 10,
    quotaCycleCount: 0,
    useResetCreditOnWeeklyLimit: false,
    resetCreditLastAttemptAt: null,
    resetCreditLastOutcome: null,
    maxRetryCount: 3,
    retryCount: 0,
    conflictRetryCount: 0,
    forkedFromThreadId: null,
    forkCount: 0,
    nextRunAt: null,
    quotaResetAt: null,
    lastProgressHash: null,
    stagnantCycleCount: 0,
    lastQuotaInterruptedAt: null,
    lastQuotaInterruptedThreadId: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    lastError: null,
    ...overrides,
  };
}

/** 建一套 harness：假 client + 内存 repo + 真 engine */
function harness(opts: { task?: Partial<ManagedTask>; maxForksPerTask?: number } = {}) {
  const repo = new FakeRepo(makeTask(opts.task));
  const client = new FakeClient();
  const engine = new TaskEngine({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: client as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repo: repo as any,
    logger: silentLogger,
    tasksDir: tmpdir(),
    maxForksPerTask: opts.maxForksPerTask,
  });
  // 默认：线程可读且不在别处运行
  client.onMethod("thread/read", () => ({ thread: { status: { type: "idle" }, turns: [] } }));
  return { repo, client, engine };
}

/** 让 turn 在下一轮宏任务里完成（此时 awaitTurnCompletion 已注册 resolver） */
function completeTurnAfter(client: FakeClient, threadId: string, turnId = "turn-1", payload?: unknown): void {
  const text = JSON.stringify(payload ?? { status: "needs_continue", remaining_items: ["still going"] });
  setTimeout(() => {
    client.emit("notification", "turn/completed", {
      threadId,
      turn: {
        id: turnId,
        status: "completed",
        items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
      },
    });
  }, 0);
}

async function captureError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the call to reject, but it resolved");
}

/* ------------------------------- 用例 ------------------------------- */

describe("writer conflict -> thread/fork 降级", () => {
  it("在 resume 撞写锁时 fork，并用子线程 id 执行 turn/start", async () => {
    const { repo, client, engine } = harness();
    client.fail("thread/resume", "thread-store conflict: thread parent-1 already has an active writer");
    client.onMethod("thread/fork", () => ({ thread: { id: "child-1", forkedFromId: "parent-1" } }));
    client.onMethod("turn/start", () => {
      completeTurnAfter(client, "child-1");
      return { turn: { id: "turn-1" } };
    });

    const outcome = await engine.runOneTurn(repo.getTask("task-1")!);
    expect(outcome.status).toBe("needs_continue");

    // 真的 fork 了，且 fork 的是父线程
    const forks = client.callsOf("thread/fork");
    expect(forks).toHaveLength(1);
    expect(forks[0]!.params.threadId).toBe("parent-1");
    expect(forks[0]!.params.excludeTurns).toBe(true);

    // turn/start 打在子线程上
    expect(client.callsOf("turn/start")).toHaveLength(1);
    expect(client.callsOf("turn/start")[0]!.params.threadId).toBe("child-1");

    // 血缘与计数已落库，冲突计数被清零
    const after = repo.getTask("task-1")!;
    expect(after.threadId).toBe("child-1");
    expect(after.sessionId).toBe("child-1");
    expect(after.forkedFromThreadId).toBe("parent-1");
    expect(after.forkCount).toBe(1);
    expect(after.conflictRetryCount).toBe(0);

    // 落了可追溯的事件
    expect(repo.events.some((e) => e.type === "thread/fork.fallback")).toBe(true);
  });

  it("不对刚 fork 出来的子线程再发 resume（子线程 writer 就是本 client）", async () => {
    const { repo, client, engine } = harness();
    client.fail("thread/resume", "thread parent-1 already has an active writer");
    client.onMethod("thread/fork", () => ({ thread: { id: "child-1" } }));
    client.onMethod("turn/start", () => {
      completeTurnAfter(client, "child-1");
      return { turn: { id: "turn-1" } };
    });

    await engine.runOneTurn(repo.getTask("task-1")!);

    const resumes = client.callsOf("thread/resume");
    expect(resumes).toHaveLength(1);
    // 唯一一次 resume 是对父线程的尝试，绝不能再对 child-1 resume
    expect(resumes[0]!.params.threadId).toBe("parent-1");
    expect(resumes.every((c) => c.params.threadId !== "child-1")).toBe(true);
  });

  it("非 writer 错误一律 fail closed：不 fork、不发起 turn", async () => {
    const { repo, client, engine } = harness();
    client.fail("thread/resume", "unauthorized: please log in again");

    const err = await captureError(() => engine.runOneTurn(repo.getTask("task-1")!));
    expect(err.message).toMatch(/unauthorized/);
    expect(client.callsOf("thread/fork")).toHaveLength(0);
    expect(client.callsOf("turn/start")).toHaveLength(0);
    expect(repo.getTask("task-1")!.threadId).toBe("parent-1");
  });

  it("线程不存在 / rollout 损坏也不视为冲突", async () => {
    const { repo, client, engine } = harness();
    client.fail("thread/resume", "thread not found: no rollout for parent-1");

    const err = await captureError(() => engine.runOneTurn(repo.getTask("task-1")!));
    expect(err.message).toMatch(/not found/);
    expect(client.callsOf("thread/fork")).toHaveLength(0);
  });

  it("fork 本身失败时，抛出的错误仍保留 writer conflict 特征（调度器据此只退避、不烧 retryCount）", async () => {
    const { repo, client, engine } = harness();
    client.fail("thread/resume", "thread parent-1 already has an active writer");
    client.fail("thread/fork", "fork rejected: parent thread is locked");

    const err = await captureError(() => engine.runOneTurn(repo.getTask("task-1")!));
    expect(err.message).toMatch(/already has an active writer/);
    expect(err.message).toMatch(/fork fallback failed/);
    expect(err.message).toMatch(/fork rejected/);
    expect(client.callsOf("turn/start")).toHaveLength(0);
  });

  it("fork 次数达到上限后不再 fork（避免无限产出孤儿线程）", async () => {
    const { repo, client, engine } = harness({ task: { forkCount: 5 }, maxForksPerTask: 5 });
    client.fail("thread/resume", "thread parent-1 already has an active writer");

    const err = await captureError(() => engine.runOneTurn(repo.getTask("task-1")!));
    expect(err.message).toMatch(/already has an active writer/);
    expect(err.message).toMatch(/fork fallback exhausted/);
    expect(err.message).toMatch(/5\/5/);
    expect(client.callsOf("thread/fork")).toHaveLength(0);
  });

  it("链式降级：新线程再被锁住时，继续 fork 出下一代（血缘与计数累加）", async () => {
    const { repo, client, engine } = harness();

    // 第一轮：parent-1 被锁 -> child-1
    client.fail("thread/resume", "thread parent-1 already has an active writer");
    client.onMethod("thread/fork", () => ({ thread: { id: "child-1" } }));
    client.onMethod("turn/start", () => {
      completeTurnAfter(client, "child-1");
      return { turn: { id: "turn-1" } };
    });
    await engine.runOneTurn(repo.getTask("task-1")!);
    expect(repo.getTask("task-1")!.threadId).toBe("child-1");

    // 第二轮：用户又点开了 child-1，它也被锁 -> child-2
    client.onMethod("thread/fork", () => ({ thread: { id: "child-2" } }));
    client.onMethod("turn/start", () => {
      completeTurnAfter(client, "child-2", "turn-2");
      return { turn: { id: "turn-2" } };
    });
    await engine.runOneTurn(repo.getTask("task-1")!);

    const after = repo.getTask("task-1")!;
    expect(after.threadId).toBe("child-2");
    expect(after.forkedFromThreadId).toBe("child-1");
    expect(after.forkCount).toBe(2);

    // 两次 fork 分别针对不同的父线程，形成连续血缘链
    const parents = client.callsOf("thread/fork").map((c) => c.params.threadId);
    expect(parents).toEqual(["parent-1", "child-1"]);
  });
});
