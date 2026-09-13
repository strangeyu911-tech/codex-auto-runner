/**
 * Scheduler —— 调度器。额度恢复后/启动时/手动触发时：
 *   autoRunEnabled && 无 RUNNING 任务 && 额度可用
 *     → claimNextRunnable → projectGuard → TaskEngine.runOneTurn
 *
 * 单并发：claimNextRunnable 已经在事务内保证全局只有一个 PREPARING；
 * 项目锁由 acquireProjectLock 保证同一目录不被并发写。
 *
 * 错误分类：
 *   额度耗尽  -> WAITING_QUOTA（由 TaskEngine 内部已处理状态转换）
 *   认证失效  -> WAITING_AUTH
 *   其他失败  -> FAILED_RETRYABLE，按退避重排
 *   写锁冲突  -> TaskEngine 内部先降级 fork 出一条新线程继续（见 ensureWritableThread）；
 *                只有 fork 也失败 / 超出 forkCount 上限时才落到这里：
 *                FAILED_RETRYABLE + 指数退避，且**不消耗 retryCount**（见 isWriterConflict）
 *
 * 重试闭环（第 7 项）：
 *   上面所有失败都落在 FAILED_RETRYABLE，而 claimNextRunnable 只认 READY，
 *   于是 tick() 开头先把**到期的** FAILED_RETRYABLE 提升回 READY，
 *   否则任务一撞就死、永远需要人工 resume。
 */

import { AppServerClient, isWriterConflict } from "@car/app-server-client";
import type { Logger } from "@car/logger";
import { SqliteRepository } from "@car/persistence";
import type { ManagedTask } from "@car/persistence";
import { TaskEngine } from "@car/task-engine";
import { prepareForRun } from "@car/git-guard";
import type { QuotaSnapshot } from "@car/quota-engine";
import { DEFAULT_DISCOVERY, runDiscovery, type DiscoveryConfig } from "./discovery.js";
import { randomUUID } from "node:crypto";

export interface SchedulerOptions {
  client: AppServerClient;
  repo: SqliteRepository;
  engine: TaskEngine;
  logger: Logger;
  isAutoRunEnabled: () => boolean;
  getQuotaSnapshot: () => QuotaSnapshot | null;
  refreshQuotaSnapshot?: () => Promise<QuotaSnapshot | null>;
  /**
   * 会话自动发现：把「被额度打断、但 CAR 还不知道」的桌面版会话自动接进来。
   * 不传则用 DEFAULT_DISCOVERY（默认启用）。
   */
  discovery?: Partial<DiscoveryConfig>;
}

export class Scheduler {
  private readonly client: AppServerClient;
  private readonly repo: SqliteRepository;
  private readonly engine: TaskEngine;
  private readonly log: Logger;
  private readonly isAutoRunEnabled: () => boolean;
  private readonly getQuotaSnapshot: () => QuotaSnapshot | null;
  private readonly refreshQuotaSnapshot?: () => Promise<QuotaSnapshot | null>;
  private readonly discoveryCfg: DiscoveryConfig;
  private lastDiscoveryAt = 0;
  private tickTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(opts: SchedulerOptions) {
    this.client = opts.client;
    this.repo = opts.repo;
    this.engine = opts.engine;
    this.log = opts.logger.child({ comp: "scheduler" });
    this.isAutoRunEnabled = opts.isAutoRunEnabled;
    this.getQuotaSnapshot = opts.getQuotaSnapshot;
    this.refreshQuotaSnapshot = opts.refreshQuotaSnapshot;
    this.discoveryCfg = { ...DEFAULT_DISCOVERY, ...(opts.discovery ?? {}) };
  }

  /** 启动周期性 tick（默认每 30 秒） */
  start(intervalMs = 30_000): void {
    this.scheduleTick(2_000);
    this.tickTimer = setInterval(() => void this.tick().catch((e) => this.log.error("tick error", { err: String(e) })), intervalMs);
    if (typeof this.tickTimer.unref === "function") this.tickTimer.unref();
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  /** 额度恢复后由 QuotaWatcher 调用 */
  async onQuotaRecovered(): Promise<void> {
    this.log.info("onQuotaRecovered -> tick");
    // 关键：tick() 只会认领 READY 任务。WAITING_QUOTA 是「被额度打断」的落点，
    // 若不在这里把它推回 READY，额度恢复后任务永远不会被认领 —— 这正是
    // 「无 goal 线程续不上」的最后一环。此处批量唤醒所有等待额度的任务。
    const woke = this.wakeQuotaWaitingTasks();
    if (woke) this.log.info("quota recovered: moved WAITING_QUOTA tasks back to READY", { count: woke });
    await this.tick();
  }

  /**
   * 把所有处于 WAITING_QUOTA 的任务推回 READY，使其可被 claim。
   * 返回被唤醒的任务数。
   */
  private wakeQuotaWaitingTasks(): number {
    const waiting = this.repo
      .listTasks()
      .filter((t) => t.status === "WAITING_QUOTA");
    for (const t of waiting) {
      this.repo.forceStatus(t.id, "READY");
      // nextRunAt 置空：额度刚恢复，应立即可跑（否则会被旧的时间戳挡住）
      this.repo.patch(t.id, {
        nextRunAt: null,
        quotaResetAt: null,
        lastError: null,
      });
      this.repo.appendEvent(t.id, "quota/recovered", {
        threadId: t.lastQuotaInterruptedThreadId ?? t.threadId ?? null,
        interruptedAt: t.lastQuotaInterruptedAt,
      });
    }
    return waiting.length;
  }

  /** 手动触发运行某任务 */
  async runNow(taskId: string): Promise<void> {
    const task = this.repo.getTask(taskId);
    if (!task) throw new Error("task not found: " + taskId);
    // 强制改为 READY 以便 claim
    if (task.status === "READY" || task.status === "NEEDS_CONTINUE" || task.status === "WAITING_QUOTA" || task.status === "WAITING_SCHEDULE" || task.status === "FAILED_RETRYABLE") {
      this.repo.forceStatus(taskId, "READY");
    }
    await this.tick();
  }

  /**
   * 把**到期的** FAILED_RETRYABLE 任务推回 READY，使其重新进入 claim 队列。
   *
   * - 普通失败：失败时 retryCount 已 +1；这里只做「到期放行」。真的用光了
   *   （retryCount >= maxRetryCount）就落 FAILED_FINAL —— 终态、UI 可见，
   *   不再无声地挂在 FAILED_RETRYABLE 上。
   * - 写锁冲突：conflictRetryCount 单独计，不受 maxRetryCount 约束，
   *   按指数退避一直重试到对方（桌面版）放锁为止 —— 这正是「用户关掉桌面版那一刻自动补跑」。
   */
  private promoteRetryableTasks(): number {
    const due = this.repo.listRetryableDue();
    let promoted = 0;
    for (const t of due) {
      if (t.retryCount >= t.maxRetryCount) {
        this.repo.forceStatus(t.id, "FAILED_FINAL");
        this.repo.patch(t.id, { nextRunAt: null });
        this.repo.appendEvent(t.id, "retry/exhausted", {
          retryCount: t.retryCount,
          maxRetryCount: t.maxRetryCount,
          lastError: t.lastError,
        });
        this.log.warn("retry budget exhausted -> FAILED_FINAL", { taskId: t.id, retryCount: t.retryCount });
        continue;
      }
      this.repo.forceStatus(t.id, "READY");
      // nextRunAt 置空：既然已经到期，就别再让旧时间戳把 claim 挡住
      this.repo.patch(t.id, { nextRunAt: null });
      this.repo.appendEvent(t.id, "retry/promoted", {
        retryCount: t.retryCount,
        conflictRetryCount: t.conflictRetryCount,
        lastError: t.lastError,
      });
      promoted++;
    }
    if (promoted) this.log.info("promoted FAILED_RETRYABLE tasks back to READY", { count: promoted });
    return promoted;
  }

  /**
   * 会话自动发现（节流版）。
   *
   * CAR 原本只会跑「队列里已有的任务」—— 桌面版哪条会话撞了 5h 限额它一无所知，
   * 用户必须醒着手动建任务。这一步把那些线程自己捡进来，
   * 是「撞限额后不用醒来」的最后一块拼图。
   *
   * 节流到 discoveryCfg.intervalMs（默认 60s）：tick 自身可能只有 10~30s，
   * 没必要每轮都跑一遍 thread/list + thread/read。
   */
  private async maybeDiscover(): Promise<void> {
    if (!this.discoveryCfg.enabled) return;
    const now = Date.now();
    if (now - this.lastDiscoveryAt < this.discoveryCfg.intervalMs) return;
    this.lastDiscoveryAt = now;
    try {
      const outcome = await runDiscovery(
        { client: this.client, repo: this.repo, logger: this.log, config: this.discoveryCfg },
        now,
      );
      if (outcome.created.length) {
        this.log.info("auto-discovery created tasks", {
          created: outcome.created.length,
          scanned: outcome.scanned,
          candidates: outcome.candidates.length,
        });
      }
    } catch (e) {
      // 发现失败不应拖垮调度循环：下一轮再试即可。
      this.log.warn("auto-discovery failed", { err: String(e) });
    }
  }

  private scheduleTick(delay: number): void {
    setTimeout(() => void this.tick().catch((e) => this.log.error("scheduled tick error", { err: String(e) })), delay);
  }

  /** 核心调度逻辑 */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!this.isAutoRunEnabled()) return;
      if (!this.client.isHealthy()) {
        this.log.debug("skip: app-server not healthy");
        return;
      }
      if (this.repo.hasRunningTask()) return;

      // 会话自动发现：把「被额度打断、但 CAR 还不知道」的桌面版会话接进队列。
      //
      // 刻意放在额度闸门**之前**。扫描只有 thread/list + thread/read（只读、不吃额度），
      // 而「被额度打断」恰恰发生在额度 exhausted 的那段时间里 —— 闸门一放
      // return，发现逻辑在最该干活的场景下反而一次都不跑，注释声称的行为和实际对不上。
      // 放在闸门之前没有副作用：新任务落库就是 READY，额度恢复那刻已经在队列里等着了。
      // 仍然留在 hasRunningTask() 之后：已有 turn 在跑时不去额外压 app-server，
      // 反正同一时刻也只能跑一个任务，晚一轮接管不吃亏。
      await this.maybeDiscover();

      // 额度检查
      const quota = this.getQuotaSnapshot();
      if (quota) {
        let effectiveQuota = quota;
        if (effectiveQuota.status === "exhausted" || effectiveQuota.status === "auth_required" || effectiveQuota.status === "unknown") {
          if (quota.status === "exhausted" && await this.tryUseResetCreditForWeeklyLimit(quota)) {
            const refreshed = await this.refreshQuotaSnapshot?.();
            if (refreshed) effectiveQuota = refreshed;
          } else {
            return;
          }
        }
        if (effectiveQuota.status === "exhausted" || effectiveQuota.status === "auth_required" || effectiveQuota.status === "unknown") {
          return;
        }
        // available / near_limit -> 继续
      }

      // 自动提升：到期的 FAILED_RETRYABLE -> READY。
      // claimNextRunnable 只认 READY，缺这一步则「撞锁 / 瞬时失败」的任务永不重试。
      this.promoteRetryableTasks();

      // 认领最高优先级
      const task = this.repo.claimNextRunnable();
      if (!task) return;

      this.log.info("claiming task", { id: task.id, title: task.title, priority: task.priority });
      await this.runTask(task);
    } finally {
      this.running = false;
    }
  }

  private async runTask(task: ManagedTask): Promise<void> {
    const log = this.log.child({ taskId: task.id });
    // 项目锁
    if (!this.repo.acquireProjectLock(task.projectPath, task.id, null)) {
      log.warn("project locked elsewhere; back to WAITING_USER");
      this.repo.forceStatus(task.id, "WAITING_USER");
      this.repo.patch(task.id, { lastError: "project locked", nextRunAt: Date.now() + 5 * 60_000 });
      return;
    }
    // git 准备
    const prep = prepareForRun(task.projectPath, {
      allowDirty: task.workspaceMode === "worktree" || process.env.CAR_ALLOW_DIRTY === "1",
    });
    if (!prep.ok) {
      log.warn("git prepare failed", { reason: prep.reason });
      this.repo.forceStatus(task.id, "WAITING_USER");
      this.repo.patch(task.id, { lastError: prep.reason ?? "git guard" });
      this.repo.releaseProjectLock(task.projectPath);
      return;
    }

    try {
      const outcome = await this.engine.runOneTurn(task);
      log.info("turn outcome", { status: outcome.status });
    } catch (e) {
      const msg = String(e);
      log.error("runOneTurn threw", { err: msg });
      // 兜底：如果还停在 RUNNING/VERIFYING 等，推进到 FAILED_RETRYABLE
      const cur = this.repo.getTask(task.id);
      if (cur && ["PREPARING", "STARTING_THREAD", "RUNNING", "VERIFYING"].includes(cur.status)) {
        this.repo.forceStatus(task.id, "FAILED_RETRYABLE");
        if (isWriterConflict(msg)) {
          // 走到这里说明引擎侧的 fork 降级已尝试过但仍未解决（fork 被拒 / fork 次数用尽）。
          // 写锁冲突：另一个 Codex 进程（通常是常驻的桌面版）正持有该线程的 writer。
          // 这不是任务的失败，因此**不消耗 retryCount**，改用独立计数 + 指数退避，
          // 等对方放锁后由 promoteRetryableTasks() 自动接上。
          const attempt = cur.conflictRetryCount + 1;
          const delayMs = writerConflictBackoffMs(attempt);
          this.repo.patch(task.id, {
            lastError: msg,
            conflictRetryCount: attempt,
            nextRunAt: Date.now() + delayMs,
          });
          this.repo.appendEvent(task.id, "retry/deferred-writer-conflict", {
            attempt,
            delayMs,
            threadId: cur.threadId ?? cur.lastQuotaInterruptedThreadId ?? null,
            error: msg,
          });
          log.warn("thread writer conflict; backing off instead of burning retries", { attempt, delayMs, err: msg });
        } else {
          this.repo.patch(task.id, { lastError: msg, retryCount: cur.retryCount + 1, nextRunAt: Date.now() + 60_000 });
        }
      }
    } finally {
      this.repo.releaseProjectLock(task.projectPath);
    }
  }

  private async tryUseResetCreditForWeeklyLimit(quota: QuotaSnapshot): Promise<boolean> {
    if (!isWeeklyLimitExhausted(quota)) return false;
    if ((quota.resetCreditsAvailable ?? 0) <= 0) return false;
    const task = this.repo.listResetCreditEligibleTasks().find((t) => canAttemptResetCredit(t));
    if (!task) return false;

    const now = Date.now();
    const idempotencyKey = `car-${task.id}-${randomUUID()}`;
    this.repo.patch(task.id, {
      resetCreditLastAttemptAt: now,
      resetCreditLastOutcome: "pending",
    });
    this.repo.appendEvent(task.id, "quota/reset-credit/attempt", { idempotencyKey, resetCreditsAvailable: quota.resetCreditsAvailable });

    try {
      const resp = await this.client.request<{ outcome?: "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed" }>(
        "account/rateLimitResetCredit/consume",
        { idempotencyKey },
      );
      const outcome = resp.outcome ?? "unknown";
      this.repo.patch(task.id, { resetCreditLastOutcome: outcome });
      this.repo.appendEvent(task.id, "quota/reset-credit/outcome", { outcome });
      this.log.warn("reset credit consume outcome", { taskId: task.id, outcome });
      if (outcome === "reset" || outcome === "alreadyRedeemed") {
        if (task.status === "WAITING_QUOTA" || task.status === "NEEDS_CONTINUE" || task.status === "READY") {
          this.repo.forceStatus(task.id, "READY");
          this.repo.patch(task.id, { nextRunAt: Date.now() + 10_000, lastError: null });
        }
        return true;
      }
      return false;
    } catch (e) {
      const err = String(e);
      this.repo.patch(task.id, { resetCreditLastOutcome: "error", lastError: err });
      this.repo.appendEvent(task.id, "quota/reset-credit/error", { error: err });
      this.log.error("reset credit consume failed", { taskId: task.id, err });
      return false;
    }
  }
}

/** 写锁冲突的指数退避：60s → 120s → 240s → 480s …，上限 15 分钟 */
const WRITER_CONFLICT_BASE_MS = 60_000;
const WRITER_CONFLICT_MAX_MS = 15 * 60_000;

export function writerConflictBackoffMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(WRITER_CONFLICT_BASE_MS * 2 ** (n - 1), WRITER_CONFLICT_MAX_MS);
}

// isWriterConflict 已下沉到 @car/app-server-client —— TaskEngine 的 fork 降级要用同一判定，
// 两处必须口径一致，否则会出现「引擎认为该 fork、调度器认为该烧 retryCount」的错位。
// 这里 re-export，保持既有 import 路径（含 scheduler-retry.test.ts）不变。
export { isWriterConflict };

function isWeeklyLimitExhausted(quota: QuotaSnapshot): boolean {
  return quota.blockingBuckets.some((b) => {
    const secondary = b.secondary;
    if (!secondary || secondary.usedPercent == null || secondary.usedPercent < 100) return false;
    return secondary.windowDurationMins == null || secondary.windowDurationMins >= 7 * 24 * 60;
  });
}

function canAttemptResetCredit(task: ManagedTask): boolean {
  if (!task.useResetCreditOnWeeklyLimit) return false;
  if (task.resetCreditLastAttemptAt == null) return true;
  return Date.now() - task.resetCreditLastAttemptAt > 60 * 60_000;
}
