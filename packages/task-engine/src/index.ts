/**
 * 任务/线程引擎。
 *
 * 职责：
 *  - thread/start（new_thread）或 thread/resume（resume/imported）
 *  - new_thread 的 turn/start 注入「原始目标 + 验收标准 + 恢复上下文」
 *  - resume/imported 线程只触发继续，让 Codex 读取原会话上下文
 *  - 监听 turn/started、turn/completed、turn/diff/updated、thread/status/changed 等通知
 *  - 解析结构化 CompletionResult（按 COMPLETION_SCHEMA）
 *  - 额度不足识别（失败 + 读取额度桶）→ WAITING_QUOTA + 保存检查点
 *  - 进展哈希 + 无进展检测
 *
 * 真实协议已探针验证（v0.142.3）：
 *   thread/start -> { thread:{ id, sessionId, status:{type} }, model, sandbox, ... }
 *   turn/start   -> { turn:{ id, status:"inProgress" } }
 *   turn/completed 通知 -> { threadId, turn:{ id, status:"completed"|"failed"|"interrupted", error? } }
 */

import { AppServerClient, isWriterConflict } from "@car/app-server-client";
import { registerThreadInDesktop } from "@car/desktop-registry";
import type { Logger } from "@car/logger";
import { SqliteRepository } from "@car/persistence";
import type { ManagedTask } from "@car/persistence";
import { progressHash, COMPLETION_SCHEMA, runValidations, validationsPassed, type CompletionResult, type ValidationResult } from "@car/validator";
import { inspect as inspectGit } from "@car/git-guard";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type SandboxPolicyParam =
  | { type: "workspaceWrite"; networkAccess?: boolean; writableRoots?: string[] }
  | { type: "readOnly"; networkAccess?: boolean }
  | { type: "dangerFullAccess" };

export type ApprovalPolicyParam = "untrusted" | "on-failure" | "on-request" | "never";

export interface TaskEngineOptions {
  client: AppServerClient;
  repo: SqliteRepository;
  logger: Logger;
  /** 任务数据目录（检查点文件）。默认 %LOCALAPPDATA%\CodexAutoRunner\tasks */
  tasksDir?: string;
  /**
   * 单任务允许的最大 fork 次数（writer conflict 降级用）。默认 5。
   *
   * 超限后不再 fork，改为退避等待 —— 避免父线程被长期持锁时无限产出孤儿线程。
   */
  maxForksPerTask?: number;
  /**
   * 桌面版侧边栏登记（见 registerDesktopVisibility）。
   *
   * 生产环境不需要配置：默认启用、默认写 `%USERPROFILE%\.codex`。
   * 提供 codexHome 主要是给测试用 —— 单测里若落到真实 codex home，
   * 就会去改用户桌面版的状态文件。
   */
  desktopRegistry?: { enabled?: boolean; codexHome?: string };
}

/** 单回合执行结果 */
export interface TurnOutcome {
  status: "completed" | "needs_continue" | "needs_user" | "blocked" | "failed" | "quota_exhausted" | "interrupted";
  result: CompletionResult | null;
  validations: ValidationResult[];
  raw: unknown;
  error: string | null;
}

export class TaskEngine {
  private readonly client: AppServerClient;
  private readonly repo: SqliteRepository;
  private readonly log: Logger;
  private readonly tasksDir: string;
  private readonly maxForksPerTask: number;
  private readonly desktopRegistry: { enabled: boolean; codexHome?: string };

  /** 当前等待中的回合：threadId -> resolve */
  private readonly pendingTurns = new Map<string, (o: TurnOutcome) => void>();

  constructor(opts: TaskEngineOptions) {
    this.client = opts.client;
    this.repo = opts.repo;
    this.log = opts.logger.child({ comp: "task-engine" });
    const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    this.tasksDir = opts.tasksDir ?? join(local, "CodexAutoRunner", "tasks");
    this.maxForksPerTask = opts.maxForksPerTask ?? 5;
    this.desktopRegistry = {
      enabled: opts.desktopRegistry?.enabled ?? process.env.CAR_DESKTOP_REGISTRY !== "0",
      codexHome: opts.desktopRegistry?.codexHome,
    };
    mkdirSync(this.tasksDir, { recursive: true });

    // 订阅通知
    this.client.on("notification", (method: string, params: unknown) => this.onNotification(method, params));
  }

  /* --------------------------- 公共入口 --------------------------- */

  /** 启动/恢复任务的一个回合：READY -> PREPARING(已由调度器推进) -> ... -> RUNNING -> VERIFYING */
  async runOneTurn(task: ManagedTask): Promise<TurnOutcome> {
    const log = this.log.child({ taskId: task.id, threadId: task.threadId ?? null });

    // 1. 准备线程
    let threadId = task.threadId;
    if (!threadId) {
      this.repo.transitionInTx(task.id, "PREPARING", "STARTING_THREAD");
      threadId = await this.startNewThread(task);
      this.repo.patch(task.id, { threadId, sessionId: threadId });
    } else {
      this.repo.transitionInTx(task.id, "PREPARING", "STARTING_THREAD");
      // 返回值可能是原线程，也可能是撞上写锁后 fork 出来的子线程
      threadId = await this.ensureWritableThread(task, threadId);
    }

    // 2. 启动回合
    this.repo.transitionInTx(task.id, "STARTING_THREAD", "RUNNING");
    const prompt = this.buildPrompt(task);
    const turnResp = await this.client.request<{ turn?: { id?: string } }>("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
      cwd: task.projectPath,
      sandboxPolicy: this.sandboxFor(task),
      approvalPolicy: this.approvalFor(task),
      outputSchema: COMPLETION_SCHEMA,
    });
    const turnId = turnResp.turn?.id;
    if (!turnId) throw new Error("turn/start returned no turn.id");
    const runId = "run_" + Math.random().toString(36).slice(2, 10);
    this.repo.insertRun(runId, task.id, turnId, "RUNNING");
    log.info("turn started", { turnId, runId });

    // 3. 等待 turn/completed
    const outcome = await this.awaitTurnCompletion(threadId, turnId);
    this.repo.appendEvent(task.id, "turn/completed", outcome, runId);

    // 4. 处理结果
    if (outcome.status === "quota_exhausted") {
      this.repo.transitionInTx(task.id, "RUNNING", "WAITING_QUOTA");
      // 落库「被额度打断」的线程与时间：这是无 goal 线程唯一的识别信号
      // （thread/goal/get 对无 goal 线程返回 goal=null，无法据此判断）。
      // 用局部变量 threadId 而非 task.threadId：新建线程的场景下 task.threadId 可能仍为 null。
      const interruptedAt = Date.now();
      this.repo.patch(task.id, {
        quotaCycleCount: task.quotaCycleCount + 1,
        quotaResetAt: null,
        lastQuotaInterruptedAt: interruptedAt,
        lastQuotaInterruptedThreadId: threadId,
      });
      this.repo.appendEvent(task.id, "quota/interrupted", {
        threadId,
        at: interruptedAt,
        error: outcome.error,
      }, runId);
      log.warn("quota interrupted", { threadId, interruptedAt });
      this.saveCheckpoint(task, outcome);
      return outcome;
    }
    if (outcome.status === "failed" || outcome.status === "interrupted") {
      this.repo.transitionInTx(task.id, "RUNNING", "FAILED_RETRYABLE");
      this.repo.patch(task.id, { lastError: outcome.error, retryCount: task.retryCount + 1 });
      return outcome;
    }

    // 5. 验证（completed / needs_continue / needs_user / blocked）
    this.repo.transitionInTx(task.id, "RUNNING", "VERIFYING");
    const validations = task.validationCommands.length
      ? await runValidations(task.validationCommands, { cwd: task.projectPath })
      : [];
    this.repo.appendEvent(task.id, "validation/results", validations, runId);
    const allOk = validationsPassed(validations, task.validationCommands);

    // 更新进展哈希
    const completed = outcome.result?.completed_items ?? [];
    const remaining = outcome.result?.remaining_items ?? [];
    const valSum = validations.map((v) => `${v.commandId}:${v.exitCode}`).join(",");
    const newHash = progressHash(this.diffHash(task.projectPath), completed, remaining, valSum);
    const stagnant = newHash === task.lastProgressHash;
    this.repo.patch(task.id, {
      lastProgressHash: newHash,
      stagnantCycleCount: stagnant ? task.stagnantCycleCount + 1 : 0,
      runCycleCount: task.runCycleCount + 1,
    });

    if (outcome.result?.status === "completed" && allOk && remaining.length === 0) {
      this.repo.transitionInTx(task.id, "VERIFYING", "COMPLETED");
      this.repo.patch(task.id, { finishedAt: Date.now() });
      this.saveCheckpoint(task, outcome);
      return outcome;
    }

    if (outcome.result?.status === "needs_continue" && task.runCycleCount + 1 < task.maxRunCycles && !stagnant) {
      this.repo.transitionInTx(task.id, "VERIFYING", "NEEDS_CONTINUE");
      this.repo.transitionInTx(task.id, "NEEDS_CONTINUE", "READY");
      this.repo.patch(task.id, { nextRunAt: Date.now() + 30_000 });
      return outcome;
    }

    // needs_user / blocked / 验证失败 / 无进展
    this.repo.transitionInTx(task.id, "VERIFYING", "WAITING_USER");
    this.repo.patch(task.id, { lastError: allOk ? null : "validation failed" });
    return outcome;
  }

  /* --------------------------- 线程操作 --------------------------- */

  private async startNewThread(task: ManagedTask): Promise<string> {
    const resp = await this.client.request<{ thread?: { id?: string } }>("thread/start", {
      cwd: task.projectPath,
      sandbox: task.sandboxMode === "readOnly" ? "read-only" : "workspace-write",
      approvalPolicy: this.approvalFor(task),
    });
    const id = resp.thread?.id;
    if (!id) throw new Error("thread/start returned no thread.id");
    this.repo.appendEvent(task.id, "thread/started", { threadId: id });
    this.registerDesktopVisibility(task, { threadId: id, cwd: task.projectPath });
    return id;
  }

  /**
   * 把 CAR 造出来的线程登记进桌面版侧边栏。
   *
   * 为什么必须有这一步：桌面版侧边栏不按 `thread/list` 渲染，它只认自己
   * `.codex-global-state.json` 里的成员表（thread-project-assignments /
   * sidebar-project-thread-orders / projectless-thread-ids），而它只在
   * 「自己建线程」或「用户改动项目根路径」时才做对账。于是 CAR 通过
   * thread/start、thread/fork 造出来的线程**永远不会**出现在侧边栏，
   * 用户既找不到也接不上 —— 等于这个自动续跑白跑。
   *
   * 登记是尽力而为：失败只记事件，绝不影响续跑主流程。
   * 桌面版正在运行时写入要等它重启才可见（它的状态在内存里）。
   */
  private registerDesktopVisibility(
    task: ManagedTask,
    args: { threadId: string; parentThreadId?: string | null; cwd?: string | null },
  ): void {
    if (!this.desktopRegistry.enabled) return;
    try {
      const res = registerThreadInDesktop({
        ...args,
        cwd: args.cwd ?? task.projectPath,
        codexHome: this.desktopRegistry.codexHome,
      });
      this.repo.appendEvent(task.id, res.ok ? "thread.desktop_registered" : "thread.desktop_register_skipped", {
        threadId: args.threadId,
        parentThreadId: args.parentThreadId ?? null,
        changed: res.changed,
        placement: res.placement,
        projectId: res.projectId,
        wroteKeys: res.wroteKeys,
        reason: res.reason,
      });
      if (!res.ok) this.log.warn("desktop sidebar registration skipped", { threadId: args.threadId, reason: res.reason });
    } catch (e) {
      this.log.warn("desktop sidebar registration failed", { threadId: args.threadId, err: String(e) });
    }
  }

  private async resumeThread(task: ManagedTask, threadId: string): Promise<void> {
    // 检查线程是否在他处活跃；同时用 turn 历史判定「上次是否被额度打断」。
    // 必须 includeTurns: true —— 否则拿不到 turns，无法判定限额语义。
    const read = await this.client.request<{
      thread?: {
        status?: { type?: string };
        turns?: Array<{ id?: string; status?: string; error?: { message?: string; codexErrorInfo?: unknown } | null }>;
      };
    }>("thread/read", { threadId, includeTurns: true });
    const statusType = read.thread?.status?.type;
    if (statusType === "active" || statusType === "running") {
      throw new Error(`THREAD_ACTIVE_ELSEWHERE: thread ${threadId} status=${statusType}`);
    }

    // 第 5 项：续跑前校验。用最近一个 turn 的 status/error 判定「是否被额度打断」。
    // 设计为告警优先、不硬拦：额度刚恢复时续跑本就是预期行为，硬拦会破坏「丝滑续跑」。
    const probe = probeQuotaInterrupted(read.thread?.turns);
    if (probe.interrupted) {
      this.log.warn("resuming a quota-interrupted thread", {
        threadId, turnId: probe.turnId, turnStatus: probe.turnStatus, errorInfo: probe.errorInfo,
      });
      this.repo.appendEvent(task.id, "thread.resume.quota_probe", {
        threadId, interrupted: true, turnId: probe.turnId,
        turnStatus: probe.turnStatus, errorInfo: probe.errorInfo,
      });
    }

    await this.ensureGoalActive(threadId);
    await this.client.request("thread/resume", { threadId, approvalPolicy: this.approvalFor(task) });
    this.repo.appendEvent(task.id, "thread.resumed", { threadId, quotaInterrupted: probe.interrupted });
  }

  /**
   * 拿到一条「本 client 可写」的线程 id。
   *
   * 先按常规 resume；仅当失败原因**确认为 writer conflict** 时，降级为 `thread/fork` ——
   * 从父线程派生一条归本 client 所有的新线程继续跑。
   *
   * fail closed：非 writer conflict 的错误（未登录 / 线程不存在 / rollout 损坏 /
   * 权限不足 / 协议版本不兼容）一律原样抛出，绝不 fork。分叉不是万能兜底，
   * 把任意失败都升级成 fork 只会掩盖真实故障并产出一堆孤儿线程。
   */
  private async ensureWritableThread(task: ManagedTask, threadId: string): Promise<string> {
    try {
      await this.resumeThread(task, threadId);
      return threadId;
    } catch (e) {
      const msg = String(e);
      if (!isWriterConflict(msg)) throw e;
      return await this.forkForWriterConflict(task, threadId, msg);
    }
  }

  /**
   * writer conflict 降级：fork 出子线程、立刻持久化，返回子线程 id。
   *
   * 关键约束（已实测踩过）：fork 必须与随后的 `turn/start` 发生在**同一个 app-server** 里。
   * 创建子线程的那个 server 天然就是它的 writer，因此这里**不再对子线程 resume** ——
   * 多一次 resume 只会在同一个 server 内自造一次 ownership 冲突。
   * 等下一个额度窗口恢复时，`task.threadId` 已指向子线程，走正常 resume 路径即可。
   *
   * 崩溃窗口：fork 返回与落库之间若进程挂掉，子线程会成为孤儿（不会自动被接管）。
   * 该窗口无法彻底消除（协议不支持 client 指定 thread id），只能① 返回后立即落库；
   * ② 用 forkCount 封顶，避免反复产出。
   */
  private async forkForWriterConflict(task: ManagedTask, parentThreadId: string, cause: string): Promise<string> {
    if (task.forkCount >= this.maxForksPerTask) {
      // 保留 writer conflict 的判定特征字符串：让调度器仍按「环境冲突」退避，
      // 而不是把它当成任务失败去烧 retryCount。
      throw new Error(
        `thread ${parentThreadId} already has an active writer; fork fallback exhausted ` +
          `(forkCount=${task.forkCount}/${this.maxForksPerTask}); last cause: ${cause}`,
      );
    }

    let childThreadId: string;
    try {
      childThreadId = await this.client.forkThread(parentThreadId);
    } catch (e) {
      // fork 也失败 —— 同样保留冲突语义，交回调度器指数退避
      throw new Error(
        `thread ${parentThreadId} already has an active writer; fork fallback failed: ${String(e)}`,
      );
    }

    // 立即落库：这是 fork 与「崩溃丢孩子」之间仅有的一段可压缩窗口
    this.repo.patch(task.id, {
      threadId: childThreadId,
      sessionId: childThreadId,
      forkedFromThreadId: parentThreadId,
      forkCount: task.forkCount + 1,
      conflictRetryCount: 0,
      lastError: null,
    });
    this.repo.appendEvent(task.id, "thread/fork.fallback", {
      parentThreadId,
      childThreadId,
      forkCount: task.forkCount + 1,
      cause,
    });
    this.log.warn("thread writer conflict; forked a writable branch instead", {
      taskId: task.id,
      parentThreadId,
      childThreadId,
      forkCount: task.forkCount + 1,
    });
    // 分叉出来的孩子是条全新线程 —— 不登记就永远不出现在桌面版侧边栏里。
    this.registerDesktopVisibility(task, { threadId: childThreadId, parentThreadId, cwd: task.projectPath });
    return childThreadId;
  }

  private async ensureGoalActive(threadId: string): Promise<void> {
    const resp = await this.client.request<{ goal?: { objective?: string; status?: string; tokenBudget?: number | null } | null }>(
      "thread/goal/get",
      { threadId },
    ).catch((err) => {
      this.log.warn("goal read failed before resume", { threadId, err: String(err) });
      return null;
    });
    const goal = resp?.goal;
    if (!goal?.objective) return;
    const inactive = goal.status && ["paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(goal.status);
    if (!inactive) return;
    await this.client.request("thread/goal/set", {
      threadId,
      objective: goal.objective,
      status: "active",
      tokenBudget: goal.tokenBudget ?? null,
    }).catch((err) => {
      this.log.warn("goal activation failed before resume", { threadId, status: goal.status, err: String(err) });
    });
  }

  /* --------------------------- 通知处理 --------------------------- */

  private onNotification(method: string, params: unknown): void {
    if (method === "turn/completed") this.handleTurnCompleted(params);
    else if (method === "turn/started") this.repo.appendEvent(null, "turn/started", params);
    else if (method === "turn/diff/updated") this.repo.appendEvent(null, "turn/diff/updated", params);
    else if (method === "turn/plan/updated") this.repo.appendEvent(null, "turn/plan/updated", params);
    else if (method === "thread/status/changed") this.repo.appendEvent(null, "thread/status/changed", params);
    else if (method === "account/rateLimits/updated") this.repo.appendEvent(null, "account/rateLimits/updated", params);
  }

  private handleTurnCompleted(params: unknown): void {
    const p = params as { threadId?: string; turn?: { id?: string; status?: string; error?: { message?: string; codexErrorInfo?: unknown } } };
    const threadId = p.threadId;
    const turnId = p.turn?.id;
    if (!threadId) return;
    const resolver = this.pendingTurns.get(threadId);
    if (!resolver) return;

    const turnStatus = (p.turn?.status ?? "failed") as TurnOutcome["status"];
    const errMsg = p.turn?.error?.message ?? null;
    const errorInfo = p.turn?.error?.codexErrorInfo;

    // 额度相关错误？
    const isQuota = isQuotaError(errorInfo, errMsg);

    if (isQuota) {
      this.log.warn("turn completed with quota error", { threadId, turnId, errorInfo, errMsg });
      resolver({ status: "quota_exhausted", result: null, validations: [], raw: params, error: errMsg });
      this.pendingTurns.delete(threadId);
      return;
    }

    if (turnStatus === "completed") {
      const result = extractCompletionResult(p.turn);
      const status = (result?.status ?? "needs_continue") as TurnOutcome["status"];
      resolver({ status, result, validations: [], raw: params, error: errMsg });
      this.pendingTurns.delete(threadId);
      return;
    }

    if (turnStatus === "interrupted") {
      resolver({ status: "interrupted", result: null, validations: [], raw: params, error: errMsg });
      this.pendingTurns.delete(threadId);
      return;
    }

    // failed
    resolver({ status: "failed", result: null, validations: [], raw: params, error: errMsg });
    this.pendingTurns.delete(threadId);
  }

  private awaitTurnCompletion(threadId: string, turnId: string): Promise<TurnOutcome> {
    return new Promise<TurnOutcome>((resolve) => {
      let quotaPollBusy = false;
      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(quotaPoll);
        this.pendingTurns.delete(threadId);
      };
      const finish = (outcome: TurnOutcome) => {
        cleanup();
        resolve(outcome);
      };
      this.pendingTurns.set(threadId, finish);
      const quotaPoll = setInterval(() => {
        if (!this.pendingTurns.has(threadId) || quotaPollBusy) return;
        quotaPollBusy = true;
        this.client.request<{ goal?: { status?: string } | null }>("thread/goal/get", { threadId })
          .then((resp) => {
            const status = resp.goal?.status;
            if (status === "usageLimited" || status === "budgetLimited") {
              this.log.warn("goal became limited while waiting for turn", { threadId, turnId, status });
              this.client.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
              finish({ status: "quota_exhausted", result: null, validations: [], raw: resp, error: status });
            }
          })
          .catch((err) => this.log.debug("goal poll failed while waiting for turn", { threadId, turnId, err: String(err) }))
          .finally(() => { quotaPollBusy = false; });
      }, 30_000);
      if (typeof quotaPoll.unref === "function") quotaPoll.unref();
      // 兜底超时：避免通知丢失导致永远挂起（默认 15 分钟）
      const timeout = setTimeout(() => {
        if (this.pendingTurns.has(threadId)) {
          this.log.warn("turn await timeout, interrupting", { threadId, turnId });
          this.client.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
          finish({ status: "interrupted", result: null, validations: [], raw: null, error: "await timeout" });
        }
      }, 15 * 60_000);
      if (typeof timeout.unref === "function") timeout.unref();
    });
  }

  /* --------------------------- 工具 --------------------------- */

  private sandboxFor(task: ManagedTask): SandboxPolicyParam {
    if (task.sandboxMode === "readOnly") return { type: "readOnly", networkAccess: task.networkAccess };
    return { type: "workspaceWrite", networkAccess: task.networkAccess };
  }

  private approvalFor(task: ManagedTask): ApprovalPolicyParam {
    // safe_autonomous -> never（不等待无人值守审批）
    // interactive    -> on-request（需要时弹审批）
    return task.approvalMode === "safe_autonomous" ? "never" : "on-request";
  }

  private buildPrompt(task: ManagedTask): string {
    if (task.mode === "resume_thread" || task.mode === "imported_thread") {
      return this.buildResumePrompt(task);
    }

    const lines: string[] = [];
    lines.push("你正在执行一个由 Codex Auto Runner 管理的任务。");
    lines.push("");
    lines.push("原始目标：");
    lines.push(task.originalGoal);
    if (task.resumeInstruction) {
      lines.push("");
      lines.push("恢复指令：");
      lines.push(task.resumeInstruction);
    }
    if (task.acceptanceCriteria.length) {
      lines.push("");
      lines.push("验收标准：");
      task.acceptanceCriteria.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
    }
    lines.push("");
    lines.push("要求：");
    lines.push("1. 不要自动 push、部署或发布。");
    lines.push("2. 不要修改 Git 历史（reset --hard、push --force、clean -fd 等）。");
    lines.push("3. 遇到需要高风险权限或歧义时停止并返回 needs_user。");
    lines.push("4. 完成后请严格按 outputSchema 返回 JSON 结果。");
    lines.push("5. remaining_items 为空且所有验证通过才算 completed。");
    return lines.join("\n");
  }

  /**
   * 续跑既有线程时的 prompt。
   *
   * 不依赖 Codex 的 goal 模式：goal 存在与否都能继续。
   * 依靠的是 thread 自身的历史上下文 + 本指令，
   * 因此无 goal 会话同样可以被接管并跨额度窗口续跑。
   */
  private buildResumePrompt(task: ManagedTask): string {
    const lines: string[] = [];
    lines.push("你正在被 Codex Auto Runner 恢复执行一个之前中断的任务。");
    lines.push("这是之前会话的延续，你之前的历史上下文都还在。");
    lines.push("");
    lines.push("请先回顾本会话中你上一次正在做的事，从中断的地方继续推进。");
    lines.push("不要重头开始，不要开启新话题，不要重复询问已经得到过的信息。");
    if (task.originalGoal?.trim()) {
      lines.push("");
      lines.push("本次要推进的工作：");
      lines.push(task.originalGoal.trim());
    }
    if (task.resumeInstruction?.trim()) {
      lines.push("");
      lines.push("恢复指令：");
      lines.push(task.resumeInstruction.trim());
    }
    if (task.acceptanceCriteria.length) {
      lines.push("");
      lines.push("验收标准：");
      task.acceptanceCriteria.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
    }
    lines.push("");
    lines.push("要求：");
    lines.push("1. 不要自动 push、部署或发布。");
    lines.push("2. 不要修改 Git 历史（reset --hard、push --force、clean -fd 等）。");
    lines.push("3. 遇到需要高风险权限或歧义时停止并返回 needs_user。");
    lines.push("4. 完成后请严格按 outputSchema 返回 JSON 结果。");
    lines.push("5. remaining_items 为空且所有验证通过才算 completed。");
    return lines.join("\n");
  }

  private diffHash(cwd: string): string {
    const st = inspectGit(cwd);
    return createHash("sha256").update(st.porcelain.join("\n") + "|" + (st.head ?? "")).digest("hex");
  }

  private saveCheckpoint(task: ManagedTask, outcome: TurnOutcome): void {
    const dir = join(this.tasksDir, task.id);
    mkdirSync(dir, { recursive: true });
    const cp = {
      taskId: task.id,
      threadId: task.threadId,
      originalGoal: task.originalGoal,
      acceptanceCriteria: task.acceptanceCriteria,
      lastResult: outcome.result,
      lastError: outcome.error,
      savedAt: Date.now(),
    };
    writeFileSync(join(dir, "checkpoint.json"), JSON.stringify(cp, null, 2));
  }

  /** 重新评估回合：暂停期间检测到工作区变化时使用 */
  async reevaluate(task: ManagedTask): Promise<void> {
    if (!task.threadId) return;
    const before = task.lastProgressHash;
    const now = this.diffHash(task.projectPath);
    if (before && before !== now) {
      this.log.warn("workspace changed while paused; re-evaluation turn", { taskId: task.id });
    }
    // 不直接续跑，交回调度器；调度器会调用 runOneTurn
  }
}

/* ------------------------------ helpers ------------------------------ */

function isQuotaError(info: unknown, msg: string | null): boolean {
  if (info === "usageLimitExceeded") return true;
  if (typeof info === "string" && info.toLowerCase().includes("usage")) return true;
  if (msg && /rate.?limit|usage limit|quota|额度|使用限制/i.test(msg)) return true;
  return false;
}

/**
 * 判定线程「最近一个 turn 是否被额度打断」。
 *
 * 这是第 5 项的权威判据，也是无 goal 线程唯一的线程侧信号：
 * - goal 侧的 thread/goal/get 对无 goal 线程返回 goal=null，无法据此判断；
 * - turn 侧的 status/error 与是否设置 goal 无关，因此对两类线程都成立。
 *
 * 判据（取最近一个 turn）：
 *   a) turn.status === "failed" 且 error.codexErrorInfo === "usageLimitExceeded"，或
 *   b) turn.status === "failed"/"interrupted" 且 error.message 命中额度关键词。
 */
export interface QuotaProbe {
  interrupted: boolean;
  turnId: string | null;
  turnStatus: string | null;
  errorInfo: string | null;
}

export function probeQuotaInterrupted(
  turns: Array<{ id?: string; status?: string; error?: { message?: string; codexErrorInfo?: unknown } | null }> | undefined,
): QuotaProbe {
  const none: QuotaProbe = { interrupted: false, turnId: null, turnStatus: null, errorInfo: null };
  if (!turns?.length) return none;
  const last = turns[turns.length - 1];
  if (!last) return none;

  const turnStatus = last.status ?? null;
  const errorInfo = typeof last.error?.codexErrorInfo === "string" ? last.error.codexErrorInfo : null;
  const errMsg = last.error?.message ?? null;

  // 只在「失败 / 被打断」的终态上判定；inProgress/completed 不算被打断
  if (turnStatus !== "failed" && turnStatus !== "interrupted") {
    return { interrupted: false, turnId: last.id ?? null, turnStatus, errorInfo };
  }

  const interrupted = isQuotaError(last.error?.codexErrorInfo, errMsg);
  return { interrupted, turnId: last.id ?? null, turnStatus, errorInfo };
}

/* ------------------------ 进程重启后的恢复判定 ------------------------ */

/** 恢复扫描要给任务落的三个去处。 */
export type RecoveryAction = "WAITING_QUOTA" | "WAITING_USER" | "READY";

/** 「崩溃留下的 RUNNING，需要人确认」的专用标记文案（恢复扫描独有，人不会写）。 */
export const RECOVERY_NEEDS_CONFIRM = "process restarted mid-run; needs user confirm";

/** 「崩溃留下的 RUNNING，且确证卡在额度上」的文案。 */
export const RECOVERY_QUOTA_DEFERRED =
  "process restarted mid-run while quota-limited; will auto-resume on recovery";

export interface RecoveryDecision {
  action: RecoveryAction;
  /** 要写进 lastError 的值；null = 清空 */
  lastError: string | null;
  /** 判定依据（写进事件，便于事后追溯「为什么它自己跑起来了」） */
  why: string;
  lastTurnStatus: string | null;
}

/**
 * 判定「进程重启时还挂在 RUNNING 的任务」下一步该去哪。
 *
 * 过去这里一律保守判成 WAITING_USER —— 用户必须醒着手动点一次续跑，
 * 这和「撞 5h 后我不用醒来」直接冲突。
 *
 * 这类任务的命运其实有两种，而且能靠**线程的 turn 历史**区分：
 *
 *   a) 最后一个 turn 是 `completed`：崩溃发生在「turn 跑完、状态还没落库」之间，
 *      活儿可能已经干完了；agent 主动停下要人决策（needs_user）也落在这里。
 *      → 保守，等人确认。
 *   b) 最后一个 turn 是 `interrupted` / `failed` / `inProgress`：
 *      这个 turn 没跑完，工作**明确**没做完 → 直接排队续跑，不需要人。
 *
 * ⚠️ 只拿 `interrupted` 回答「活干完了没有」，**绝不要**拿它反推「是不是额度打断」：
 *    实测 8/8 的 interrupted turn 都是 `error=null`，这个状态不携带任何成因，
 *    据此放宽额度判定会把用户主动停掉的线程也捡起来（正是 discovery 明令禁止的误捡）。
 *
 * 读不到线程历史时一律 fail closed（→ WAITING_USER）：宁可漏续，不可误续。
 */
export function decideRecovery(input: {
  /** CAR 侧已确证的额度特征（task_runs.quota_exhausted 或 lastQuotaInterruptedAt） */
  quotaHit: boolean;
  /** 线程历史是否成功读到 */
  threadReadable: boolean;
  turns: Array<{ id?: string; status?: string }> | undefined;
}): RecoveryDecision {
  const turns = input.turns ?? [];
  const last = turns.length ? turns[turns.length - 1] : undefined;
  const lastTurnStatus = last?.status ?? null;

  if (input.quotaHit) {
    // 额度语义优先：等额度恢复时由 onQuotaRecovered() 推回 READY，
    // 比直接排队更准（能用上 quotaResetAt）
    return {
      action: "WAITING_QUOTA",
      lastError: RECOVERY_QUOTA_DEFERRED,
      why: "quota fingerprint recorded on the task itself",
      lastTurnStatus,
    };
  }
  if (!input.threadReadable) {
    return {
      action: "WAITING_USER",
      lastError: RECOVERY_NEEDS_CONFIRM,
      why: "thread history unreadable; cannot tell whether the turn finished",
      lastTurnStatus: null,
    };
  }
  if (!last) {
    return {
      action: "WAITING_USER",
      lastError: RECOVERY_NEEDS_CONFIRM,
      why: "thread has no turns; nothing to resume",
      lastTurnStatus: null,
    };
  }
  if (lastTurnStatus === "completed") {
    return {
      action: "WAITING_USER",
      lastError: RECOVERY_NEEDS_CONFIRM,
      why: "last turn completed before the crash; the agent may be waiting for a human",
      lastTurnStatus,
    };
  }
  if (lastTurnStatus === "interrupted" || lastTurnStatus === "failed" || lastTurnStatus === "inProgress") {
    return {
      action: "READY",
      lastError: null,
      why: `last turn is ${lastTurnStatus}; the run was cut off before finishing`,
      lastTurnStatus,
    };
  }
  // 状态缺失 / 不认识的状态 —— 连「跑完没有」都判断不了，fail closed
  return {
    action: "WAITING_USER",
    lastError: RECOVERY_NEEDS_CONFIRM,
    why: `last turn status is ${lastTurnStatus ?? "unset"}; not a recognised terminal state, so fail closed`,
    lastTurnStatus,
  };
}

/** 从 turn/completed 的 items 中抽取结构化 CompletionResult */
function extractCompletionResult(turn: unknown): CompletionResult | null {
  const t = turn as { items?: Array<{ type?: string; role?: string; content?: Array<{ type?: string; text?: string }> }> };
  const items = t?.items ?? [];
  // 找最后一条 assistant message 文本
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!it) continue;
    const contents = it.content ?? [];
    for (let j = contents.length - 1; j >= 0; j--) {
      const c = contents[j];
      if (!c) continue;
      const text = c.text;
      if (typeof text !== "string") continue;
      // 尝试从文本里抽 JSON（模型可能包裹在 ```json ... ```）
      const parsed = tryParseJsonFromText(text);
      if (parsed && typeof parsed === "object" && "status" in parsed) {
        return parsed as CompletionResult;
      }
    }
  }
  return null;
}

function tryParseJsonFromText(text: string): unknown {
  // 直接
  try { return JSON.parse(text); } catch { /* continue */ }
  // ```json ... ```
  const m1 = text.match(/```json\s*([\s\S]*?)```/i);
  if (m1 && m1[1]) {
    try { return JSON.parse(m1[1].trim()); } catch { /* continue */ }
  }
  // 第一个 { ... 最后一个 }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* continue */ }
  }
  return null;
}
