import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedTask } from "@car/persistence";
import { TaskEngine } from "../src/index.js";

/**
 * 「续跑时对话别太乱」的回归。
 *
 * 背景（用户实测反馈 2026-09-14）：GUI 里能看到续跑的线程了，但读起来
 * 「太乱，不能算续跑成功」—— 每轮都把一份 12 行的指令块原样注入，
 * 结尾还逼模型吐一坨 JSON（`outputSchema` 约束的是**最终那条 assistant 消息**，
 * 也就是用户看得见的那条）。
 *
 * 本文件锁住四件事：
 *   1. 第 2 轮起只发一句「继续任务。」（完整指令只在首轮出现）
 *   2. 不再传 outputSchema —— 模型正常说话即可
 *   3. 状态从「项目里的 .car/status.json」取，回复里不再需要 JSON
 *   4. 三级回退顺序：状态文件 → 回复正文 JSON → app-server 原生信号
 *
 * 刻意不碰真仓库：这层逻辑与 SQLite 无关（原因同 fork-fallback.test.ts）。
 */

/* ----------------------------- 测试替身 ----------------------------- */

type Call = { method: string; params: Record<string, unknown> };

class FakeClient extends EventEmitter {
  readonly calls: Call[] = [];
  private readonly handlers = new Map<string, (params: Record<string, unknown>) => unknown>();

  onMethod(method: string, fn: (params: Record<string, unknown>) => unknown): void {
    this.handlers.set(method, fn);
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params: params ?? {} });
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`FakeClient: unexpected method ${method}`);
    return await handler(params ?? {});
  }

  callsOf(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** 第 n 次 turn/start 注入的 prompt 文本 */
  promptOf(n: number): string {
    const call = this.callsOf("turn/start")[n];
    const input = call?.params["input"] as Array<{ text?: string }> | undefined;
    return input?.[0]?.text ?? "";
  }
}

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

function makeTask(projectPath: string, overrides: Partial<ManagedTask> = {}): ManagedTask {
  const now = Date.now();
  return {
    id: "task-1",
    title: "quiet resume fixture",
    mode: "resume_thread",
    projectPath,
    threadId: "parent-1",
    sessionId: "parent-1",
    originalGoal: "把迁移脚本跑通",
    resumeInstruction: "接着上次的进度",
    acceptanceCriteria: [],
    priority: 50,
    status: "READY",
    model: null,
    sandboxMode: "workspaceWrite",
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

/** 建一个带 `.git/info/exclude` 的临时「项目」，用于验证 git exclude 行为 */
function makeProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "car-quiet-resume-"));
  mkdirSync(join(dir, ".git", "info"), { recursive: true });
  writeFileSync(join(dir, ".git", "info", "exclude"), "# 别人的仓库 exclude\n", "utf8");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf8");
  return dir;
}

function harness(opts: { task?: Partial<ManagedTask>; goalStatus?: string | null } = {}) {
  const projectPath = opts.task?.projectPath ?? makeProjectDir();
  const repo = new FakeRepo(makeTask(projectPath, opts.task));
  const client = new FakeClient();
  const codexHome = mkdtempSync(join(tmpdir(), "car-quiet-resume-home-"));

  client.onMethod("thread/read", () => ({ thread: { status: { type: "idle" }, turns: [] } }));
  client.onMethod("thread/resume", () => ({}));
  client.onMethod("turn/start", () => ({ turn: { id: "turn-" + (client.callsOf("turn/start").length) } }));
  // 原生信号兜底会在「文件与正文都没有结论」时探一次 goal；默认无 goal。
  // 注意 mock 里刻意不给 objective —— 否则 resume 前的 ensureGoalActive 会去调 thread/goal/set。
  client.onMethod("thread/goal/get", () => ({ goal: opts.goalStatus ? { status: opts.goalStatus } : null }));

  const engine = new TaskEngine({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: client as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repo: repo as any,
    logger: silentLogger,
    tasksDir: tmpdir(),
    desktopRegistry: { enabled: false, codexHome },
  });
  return { repo, client, engine, projectPath };
}

/**
 * 跑一轮：启动 turn，然后在下一轮宏任务里完成它。
 *
 * `replyText` 是模型「正常说话」的回复（默认不含任何 JSON）。
 *
 * ⚠️ 这里必须用**真实载荷形状**：codex 0.153.4 的 turn/completed 里，
 * assistant 文本直接挂在 `item.text` 上（item 键为 type/id/text/phase/…），
 * 没有 `content[]` 数组。若照 `content[].text` 造数据，测试会全绿而真机全崩
 * —— 这正是「模型说 needs_user、CAR 读成 needs_continue」那个 bug 的成因。
 */
async function runTurn(
  h: ReturnType<typeof harness>,
  task: ManagedTask,
  opts: { replyText?: string; replyPhase?: string | null; extraItems?: unknown[]; duringTurn?: () => void; threadId?: string } = {},
) {
  const threadId = opts.threadId ?? task.threadId ?? "parent-1";
  const p = h.engine.runOneTurn(task);
  setTimeout(() => {
    opts.duringTurn?.(); // 模拟「模型在这一轮里写了状态文件」
    h.client.emit("notification", "turn/completed", {
      threadId,
      turn: {
        id: "turn-1",
        status: "completed",
        itemsView: "full",
        items: [
          {
            type: "agentMessage",
            id: "msg-1",
            text: opts.replyText ?? "这轮把迁移脚本的第二步跑通了，剩下的在下一步。",
            phase: opts.replyPhase ?? null,
            memoryCitation: null,
            delivery: null,
          },
          ...(opts.extraItems ?? []),
        ],
      },
    });
  }, 0);
  return await p;
}

const STATUS_FILE = ".car/status.json";

/** 模拟「模型在这一轮里把结论写进了状态文件」（目录可能是 CAR 刚建的，也可能还没建） */
function writeStatus(projectPath: string, body: unknown): void {
  mkdirSync(join(projectPath, ".car"), { recursive: true });
  writeFileSync(join(projectPath, STATUS_FILE), JSON.stringify(body), "utf8");
}

/* ------------------------------- 断言 ------------------------------- */

describe("续跑 prompt 不再刷屏", () => {
  it("第 1 轮给完整指令，第 2 轮只给一句「继续任务。」", async () => {
    const h = harness();
    const first = h.repo.getTask("task-1")!;
    await runTurn(h, first);

    const second = h.repo.getTask("task-1")!;
    expect(second.runCycleCount).toBe(1);
    await runTurn(h, second);

    const prompt1 = h.client.promptOf(0);
    const prompt2 = h.client.promptOf(1);

    // 首轮：带着目标 + 约束
    expect(prompt1).toContain("继续任务。");
    expect(prompt1).toContain("把迁移脚本跑通");
    expect(prompt1).toContain("不 push");

    // 次轮：就一句话，不再重复整份指令
    expect(prompt2.trim()).toBe("继续任务。");
    expect(prompt2).not.toContain("不 push");
  });

  it("不再传 outputSchema（它会把用户在桌面版里看到的那条消息压成 JSON）", async () => {
    const h = harness();
    await runTurn(h, h.repo.getTask("task-1")!);
    for (const call of h.client.callsOf("turn/start")) {
      expect(call.params["outputSchema"]).toBeUndefined();
    }
  });
});

/**
 * 回归：真实载荷形状必须能被解析。
 *
 * 背景（实测 2026-09-15）：codex 0.153.4 的 turn/completed 里 assistant 文本挂在
 * `item.text` 上，旧代码却按 `item.content[].text` 取，取到空数组 → 永远 null。
 * 后果不是「少了个字段」而是**任务不会停**：模型说 needs_user，CAR 读成
 * needs_continue，于是反复续跑、反复烧额度。
 */
describe("回复正文通道（兼容旧线程时的兜底）", () => {
  it("真实形状 items[].text 里的结论会被采纳", async () => {
    const h = harness();
    const outcome = await runTurn(h, h.repo.getTask("task-1")!, {
      replyText: JSON.stringify({ status: "completed", summary: "都做完了", remaining_items: [] }),
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.result?.summary).toBe("都做完了");
  });

  it("模型说 needs_user 时不会被读成 needs_continue（否则会无限续跑）", async () => {
    const h = harness();
    const outcome = await runTurn(h, h.repo.getTask("task-1")!, {
      replyText: JSON.stringify({
        status: "needs_user",
        summary: "需要你决定验收口径",
        needs_user_reason: "两条路线都可行",
      }),
    });
    expect(outcome.status).toBe("needs_user");
    expect(outcome.result?.needs_user_reason).toBe("两条路线都可行");
  });

  it("phase=final_answer 优先于 commentary（过程叙述里也出现 JSON 时）", async () => {
    const h = harness();
    const outcome = await runTurn(h, h.repo.getTask("task-1")!, {
      replyPhase: "commentary",
      replyText: JSON.stringify({ status: "needs_continue", summary: "过程中的一版结论" }),
      extraItems: [
        {
          type: "agentMessage",
          id: "msg-2",
          phase: "final_answer",
          text: JSON.stringify({ status: "completed", summary: "终局结论", remaining_items: [] }),
          memoryCitation: null,
          delivery: null,
        },
      ],
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.result?.summary).toBe("终局结论");
  });

  it("旧形状 content[].text 仍然认得（老版本/防御性兼容）", async () => {
    const h = harness();
    const outcome = await runTurn(h, h.repo.getTask("task-1")!, {
      replyText: "（这个字段不会用到）",
      extraItems: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: JSON.stringify({ status: "completed", summary: "老形状说的", remaining_items: [] }) },
          ],
        },
      ],
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.result?.summary).toBe("老形状说的");
  });
});

describe("状态取自主状态文件", () => {
  it("模型只正常说话，CAR 从 .car/status.json 取结论", async () => {
    const h = harness();
    const outcome = await runTurn(h, h.repo.getTask("task-1")!, {
      replyText: "我把第二步跑通了，剩下的下一步做。",
      duringTurn: () => {
        writeStatus(h.projectPath, {
          status: "needs_continue",
          summary: "第二步已跑通",
          completed_items: ["第二步"],
          remaining_items: ["第三步"],
        });
      },
    });

    expect(outcome.status).toBe("needs_continue");
    expect(outcome.result?.summary).toBe("第二步已跑通");
    // 缺的字段被补齐，而不是判失败
    expect(outcome.result?.risk_notes).toEqual([]);
    expect(outcome.result?.needs_user_reason).toBeNull();
  });

  it("状态文件优先于回复正文里的 JSON", async () => {
    const h = harness();
    const outcome = await runTurn(h, h.repo.getTask("task-1")!, {
      // 正文里塞一个「相反」的结论，文件应当胜出
      replyText: '{"status":"completed","summary":"正文说的","remaining_items":[]}',
      duringTurn: () => {
        writeStatus(h.projectPath, { status: "needs_user", summary: "文件说的", needs_user_reason: "要你拍板" });
      },
    });
    expect(outcome.result?.summary).toBe("文件说的");
    expect(outcome.status).toBe("needs_user");
  });

  it("上一轮的状态文件残留不会被当成本轮结论", async () => {
    const h = harness();
    // 回合开始前就存在一份「上一轮」的文件；prepareStatusFile 必须先清掉它
    mkdirSync(join(h.projectPath, ".car"), { recursive: true });
    writeFileSync(
      join(h.projectPath, STATUS_FILE),
      JSON.stringify({ status: "completed", summary: "上一轮的陈旧结论", remaining_items: [] }),
      "utf8",
    );

    const outcome = await runTurn(h, h.repo.getTask("task-1")!);

    expect(outcome.result?.summary).not.toBe("上一轮的陈旧结论");
    expect(outcome.status).toBe("needs_continue");
  });

  it("把 .car/ 加进 .git/info/exclude，且只加一次、不动被跟踪的 .gitignore", async () => {
    const h = harness();
    const excludePath = join(h.projectPath, ".git", "info", "exclude");

    await runTurn(h, h.repo.getTask("task-1")!);
    const after1 = readFileSync(excludePath, "utf8");
    expect(after1).toContain(".car/");
    expect(after1).toContain("# 别人的仓库 exclude"); // 原有内容不动

    await runTurn(h, h.repo.getTask("task-1")!);
    const after2 = readFileSync(excludePath, "utf8");
    expect(after2).toBe(after1); // 幂等

    expect(readFileSync(join(h.projectPath, ".gitignore"), "utf8")).toBe("node_modules/\n");
  });

  it("只读沙盒拿不到这条通道（不建 .car，也不提示写文件）", async () => {
    const h = harness({ task: { sandboxMode: "readOnly" } });
    await runTurn(h, h.repo.getTask("task-1")!);
    expect(h.client.promptOf(0)).not.toContain(STATUS_FILE);
    expect(existsSync(join(h.projectPath, ".car"))).toBe(false);
  });
});

describe("原生信号兜底（模型什么都不给时）", () => {
  it("goal 被标记 blocked → needs_user", async () => {
    const h = harness({ goalStatus: "blocked" });
    const outcome = await runTurn(h, h.repo.getTask("task-1")!, { replyText: "我卡住了，等你定。" });
    expect(outcome.status).toBe("needs_user");
    expect(outcome.result?.needs_user_reason).toContain("blocked");
  });

  it("goal 被标记 complete → completed", async () => {
    const h = harness({ goalStatus: "complete" });
    const outcome = await runTurn(h, h.repo.getTask("task-1")!, { replyText: "做完了。" });
    expect(outcome.status).toBe("completed");
  });

  it("线程正在等用户输入（activeFlags=waitingOnUserInput）→ needs_user", async () => {
    const h = harness();
    const outcome = await runTurn(h, h.repo.getTask("task-1")!, {
      replyText: "这个选择需要你来定。",
      duringTurn: () => {
        h.client.emit("notification", "thread/status/changed", {
          threadId: "parent-1",
          status: { type: "active", activeFlags: ["waitingOnUserInput"] },
        });
      },
    });
    expect(outcome.status).toBe("needs_user");
  });

  it("三级都不命中 → 退化成 needs_continue，且不抛异常", async () => {
    const h = harness();
    const outcome = await runTurn(h, h.repo.getTask("task-1")!, { replyText: "我继续往下做。" });
    expect(outcome.status).toBe("needs_continue");
    expect(outcome.result).toBeNull();
  });
});
