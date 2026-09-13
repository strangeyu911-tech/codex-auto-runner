/**
 * 会话自动发现 —— 让 CAR 不再依赖「用户手动建任务」。
 *
 * 背景：CAR 是任务队列，不是守护进程。桌面版哪条会话撞了 5h 限额，
 * CAR 原本完全不知道（`lastQuotaInterruptedAt` 全为 null），
 * 用户必须醒着在 UI 里挑线程、手动建任务 —— 这与「撞限额后我不用醒来」直接冲突。
 *
 * 本模块周期性扫描 Codex 的会话列表，挑出「最近一个 turn 因额度限制失败、
 * 且尚未被 CAR 接管」的线程，自动建一条 `resume_thread` 任务。
 *
 * 「被额度打断」的判定复用 task-engine 的 `probeQuotaInterrupted`：
 * 它与线程是否设置 goal 无关，是线程侧唯一可靠信号。
 *
 * 安全边界（宁可漏捡，不可误捡）：
 *   - 只捡「最后一个 turn 确实是 failed/interrupted 且错误命中额度特征」的线程；
 *     正常结束、用户主动 Esc 中断的都不算。
 *   - 跳过 active/running —— 别的进程正在跑的线程绝不抢。
 *   - 已有活跃 CAR 任务的线程不重复建。
 *   - CANCELLED / FAILED_FINAL 过的线程永久跳过：那是用户明确表示「不要了」，
 *     否则每次扫描都会把用户刚取消的任务再建回来。
 *   - 超过 lookbackMs 没动过的陈旧会话不捡。
 *   - 项目目录已不存在的线程不捡（续跑无意义）。
 *   - 单次扫描最多建 maxPerScan 条，避免一次性爆发。
 */

import type { AppServerClient } from "@car/app-server-client";
import type { Logger } from "@car/logger";
import { TERMINAL_STATUSES, type CreateTaskInput, type SqliteRepository } from "@car/persistence";
import { probeQuotaInterrupted } from "@car/task-engine";
import { existsSync } from "node:fs";
import { toMillis } from "./time.js";

export interface DiscoveryConfig {
  enabled: boolean;
  /** 两次扫描之间的最小间隔（tick 比它密时会跳过）。默认 60s */
  intervalMs: number;
  /** 只捡最近这段时间内活跃过的线程。默认 12h */
  lookbackMs: number;
  /** 每次扫描从 thread/list 取多少条 */
  scanLimit: number;
  /** 单次扫描最多自动建几条任务 */
  maxPerScan: number;
  /** 自动建的任务优先级。默认低于手动任务，手动建的应当先跑 */
  priority: number;
}

export const DEFAULT_DISCOVERY: DiscoveryConfig = {
  enabled: true,
  intervalMs: 60_000,
  lookbackMs: 12 * 60 * 60 * 1000,
  scanLimit: 20,
  maxPerScan: 2,
  priority: 40,
};

const DEFAULT_RESUME_INSTRUCTION =
  "继续完成这个会话中被中断的工作。不要重头开始，不要开启新话题。遇到需要我决策的高风险操作时停下来并返回 needs_user。";

export interface DiscoveryDeps {
  client: AppServerClient;
  repo: SqliteRepository;
  logger: Logger;
  config?: Partial<DiscoveryConfig>;
}

/** 被判定为「需要接管」的线程 */
export interface DiscoveredThread {
  threadId: string;
  cwd: string;
  title: string;
  lastTurnId: string | null;
  errorInfo: string | null;
  updatedAt: number | null;
}

export interface DiscoveryOutcome {
  scanned: number;
  skipped: Array<{ threadId: string; reason: string }>;
  candidates: DiscoveredThread[];
  created: string[];
}

/**
 * 线程被永久封锁的原因集合。
 *
 * CANCELLED / FAILED_FINAL 都是「用户或系统已经对这条线程下过结论」的终态：
 * 前者是用户主动取消，后者是重试耗尽。再自动建任务等于把用户的决定推翻，
 * 而且会在每次扫描里重复发生。
 */
function buildThreadIndex(repo: SqliteRepository): { blocked: Set<string>; busy: Set<string> } {
  const blocked = new Set<string>();
  const busy = new Set<string>();
  for (const t of repo.listTasks()) {
    const ids = [t.threadId, t.forkedFromThreadId].filter((x): x is string => !!x);
    if (ids.length === 0) continue;
    if (t.status === "CANCELLED" || t.status === "FAILED_FINAL") {
      for (const id of ids) blocked.add(id);
    } else if (!TERMINAL_STATUSES.has(t.status)) {
      for (const id of ids) busy.add(id);
    }
  }
  return { blocked, busy };
}

function str(obj: unknown, key: string): string | null {
  if (!obj || typeof obj !== "object") return null;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

function num(obj: unknown, key: string): number | null {
  if (!obj || typeof obj !== "object") return null;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "number" ? v : null;
}

function nested(obj: unknown, key: string, child: string): string | null {
  if (!obj || typeof obj !== "object") return null;
  const inner = (obj as Record<string, unknown>)[key];
  if (!inner || typeof inner !== "object") return null;
  const v = (inner as Record<string, unknown>)[child];
  return typeof v === "string" ? v : null;
}

/** 扫描一轮，返回「值得接管」的线程。不写任何东西。 */
export async function findInterruptedThreads(
  deps: DiscoveryDeps,
  now: number = Date.now(),
): Promise<DiscoveryOutcome> {
  const cfg = { ...DEFAULT_DISCOVERY, ...(deps.config ?? {}) };
  const log = deps.logger.child({ comp: "discovery" });
  const { blocked, busy } = buildThreadIndex(deps.repo);

  const listed = await deps.client
    .request<{ data?: unknown[] }>("thread/list", {
      limit: cfg.scanLimit,
      sortDirection: "desc",
      sortKey: "recency_at",
    })
    .catch((err) => {
      log.warn("thread/list failed; skipping this scan", { err: String(err) });
      return { data: [] as unknown[] };
    });

  const rows = listed.data ?? [];
  const skipped: Array<{ threadId: string; reason: string }> = [];
  const candidates: DiscoveredThread[] = [];

  for (const row of rows) {
    const threadId = str(row, "id");
    if (!threadId) continue;
    const skip = (reason: string) => skipped.push({ threadId, reason });

    if (blocked.has(threadId)) {
      skip("marked cancelled or finally failed by the user");
      continue;
    }
    if (busy.has(threadId)) {
      skip("already owned by an active task");
      continue;
    }

    const statusType = nested(row, "status", "type");
    if (statusType === "active" || statusType === "running") {
      skip("thread is active elsewhere");
      continue;
    }

    const updatedAt = toMillis(num(row, "updatedAt"));
    if (updatedAt != null && now - updatedAt > cfg.lookbackMs) {
      skip("stale session");
      continue;
    }

    const cwd = str(row, "cwd");
    if (!cwd) {
      skip("session has no cwd");
      continue;
    }
    if (!existsSync(cwd)) {
      skip("project directory no longer exists");
      continue;
    }

    // 只有在「最近一个 turn 确实因额度失败」时才需要接管。
    // includeTurns 必须为 true，否则拿不到 turns，无法判定限额语义。
    const read = await deps.client
      .request<{ thread?: { turns?: Parameters<typeof probeQuotaInterrupted>[0] } }>("thread/read", {
        threadId,
        includeTurns: true,
      })
      .catch((err) => {
        log.debug("thread/read failed during discovery", { threadId, err: String(err) });
        return null;
      });
    if (!read?.thread) {
      skip("thread could not be read");
      continue;
    }

    const probe = probeQuotaInterrupted(read.thread.turns);
    if (!probe.interrupted) {
      skip("last turn was not quota-limited");
      continue;
    }

    const name = str(row, "name");
    const preview = str(row, "preview") ?? "";
    candidates.push({
      threadId,
      cwd,
      title: (name || preview || threadId).slice(0, 100),
      lastTurnId: probe.turnId,
      errorInfo: probe.errorInfo,
      updatedAt,
    });
  }

  return { scanned: rows.length, skipped, candidates, created: [] };
}

/**
 * 扫描 + 建任务。返回本轮结果，供调用方落日志/事件。
 *
 * 关闭开关时直接返回空结果，不触碰 app-server。
 */
export async function runDiscovery(deps: DiscoveryDeps, now: number = Date.now()): Promise<DiscoveryOutcome> {
  const cfg = { ...DEFAULT_DISCOVERY, ...(deps.config ?? {}) };
  const log = deps.logger.child({ comp: "discovery" });
  if (!cfg.enabled) return { scanned: 0, skipped: [], candidates: [], created: [] };

  const outcome = await findInterruptedThreads(deps, now);

  for (const cand of outcome.candidates.slice(0, cfg.maxPerScan)) {
    const input: CreateTaskInput = {
      title: `Auto-resume: ${cand.title}`,
      projectPath: cand.cwd,
      originalGoal: "",
      resumeInstruction: DEFAULT_RESUME_INSTRUCTION,
      mode: "resume_thread",
      threadId: cand.threadId,
      priority: cfg.priority,
      sandboxMode: "workspaceWrite",
      approvalMode: "safe_autonomous",
      workspaceMode: "direct",
      maxRunCycles: 5,
      maxRetryCount: 3,
    };
    try {
      const task = deps.repo.createTask(input);
      deps.repo.appendEvent(task.id, "discovery/adopted", {
        threadId: cand.threadId,
        lastTurnId: cand.lastTurnId,
        errorInfo: cand.errorInfo,
        cwd: cand.cwd,
      });
      outcome.created.push(task.id);
      log.warn("adopted an interrupted session", {
        taskId: task.id,
        threadId: cand.threadId,
        cwd: cand.cwd,
        title: cand.title,
      });
    } catch (err) {
      log.error("failed to create a task for a discovered session", {
        threadId: cand.threadId,
        err: String(err),
      });
    }
  }

  if (outcome.created.length) {
    log.info("discovery created tasks", { created: outcome.created.length, scanned: outcome.scanned });
  }
  // 把跳过原因聚合成分布 —— 排查「为什么我的会话没被接管」时，
  // 一眼就能看出是「不是额度打断」还是「已被任务占用」。
  const reasons: Record<string, number> = {};
  for (const s of outcome.skipped) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
  log.debug("discovery scan complete", {
    scanned: outcome.scanned,
    candidates: outcome.candidates.length,
    created: outcome.created.length,
    skipped: reasons,
  });
  return outcome;
}
