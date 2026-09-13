/**
 * 任务领域模型（与文档第 11 节对应，缩简到 V1 实际所需字段）。
 * 由 persistence 序列化为 JSON 字符串存入 tasks 表。
 */

export type TaskMode = "new_thread" | "resume_thread" | "imported_thread";

export interface ValidationCommand {
  id: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  required?: boolean;
  allowNetwork?: boolean;
}

export interface ManagedTask {
  id: string;
  title: string;
  mode: TaskMode;
  projectPath: string;
  threadId: string | null;
  sessionId: string | null;

  originalGoal: string;
  resumeInstruction: string;
  acceptanceCriteria: string[];

  priority: number;
  status: TaskStatus;

  model: string | null;
  sandboxMode: "readOnly" | "workspaceWrite";
  networkAccess: boolean;
  approvalMode: "safe_autonomous" | "interactive";

  workspaceMode: "direct" | "worktree";
  branchName: string | null;
  worktreePath: string | null;

  validationCommands: ValidationCommand[];

  maxRunCycles: number;
  runCycleCount: number;
  maxQuotaCycles: number;
  quotaCycleCount: number;
  useResetCreditOnWeeklyLimit: boolean;
  resetCreditLastAttemptAt: number | null;
  resetCreditLastOutcome: string | null;
  maxRetryCount: number;
  retryCount: number;

  /**
   * 「外部冲突」退避计数，与 retryCount 分开计。
   *
   * 撞上别的 Codex 进程持有的线程写锁（桌面版与 CAR 各跑自己的 app-server、共享 ~/.codex）
   * 属于环境冲突，不是任务自身失败 —— 消耗 maxRetryCount 会导致任务在用户还没来得及
   * 关掉桌面版那条线程时就「重试耗尽」变成 FAILED_FINAL。因此单独计数、指数退避，
   * 一直等到对方放锁为止。
   */
  conflictRetryCount: number;

  nextRunAt: number | null;
  quotaResetAt: number | null;
  lastProgressHash: string | null;
  stagnantCycleCount: number;

  /**
   * 最近一次因额度（5h 窗口 / 周额度）被打断的时间。
   * 用于「无 goal 线程也能被识别并优先续跑」：goal 为 null 的线程不写 goal 状态，
   * 因此识别信号必须落在 tasks 表上，不能依赖 thread/goal/get。
   */
  lastQuotaInterruptedAt: number | null;
  /** 最近一次因额度被打断时所绑定的线程 id（可能是本任务刚新建的线程）。 */
  lastQuotaInterruptedThreadId: string | null;

  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  lastError: string | null;
}

export type TaskStatus =
  | "DRAFT"
  | "READY"
  | "PREPARING"
  | "STARTING_THREAD"
  | "RUNNING"
  | "WAITING_QUOTA"
  | "WAITING_AUTH"
  | "WAITING_USER"
  | "WAITING_SCHEDULE"
  | "VERIFYING"
  | "NEEDS_CONTINUE"
  | "PAUSED"
  | "CANCELLING"
  | "COMPLETED"
  | "FAILED_RETRYABLE"
  | "FAILED_FINAL"
  | "CANCELLED"
  | "RECOVERING";

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "COMPLETED",
  "FAILED_FINAL",
  "CANCELLED",
]);

/** 合法状态转换（文档第 12.2 节）。非法返回 false；同值返回 true。 */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  DRAFT: ["READY"],
  READY: ["PREPARING", "PAUSED"],
  PREPARING: ["STARTING_THREAD", "WAITING_USER", "FAILED_FINAL"],
  STARTING_THREAD: ["RUNNING", "WAITING_QUOTA", "WAITING_AUTH", "FAILED_RETRYABLE"],
  RUNNING: ["VERIFYING", "WAITING_QUOTA", "WAITING_USER", "FAILED_RETRYABLE", "FAILED_FINAL", "CANCELLING", "WAITING_AUTH"],
  // WAITING_USER：引擎在 Codex 未返回结构化 result（无法判定是否完成）时走此出边。
  // 缺失这条边会导致任务永久卡在 VERIFYING（转换静默失败，无任何日志）。
  VERIFYING: ["COMPLETED", "NEEDS_CONTINUE", "WAITING_USER", "FAILED_RETRYABLE"],
  NEEDS_CONTINUE: ["READY"],
  WAITING_QUOTA: ["READY"],
  WAITING_AUTH: ["READY"],
  WAITING_USER: ["READY"],
  WAITING_SCHEDULE: ["READY"],
  FAILED_RETRYABLE: ["READY"],
  PAUSED: [], // 终止调度语义；可手工 READY
  CANCELLING: ["CANCELLED"],
  COMPLETED: [],
  FAILED_FINAL: [],
  CANCELLED: [],
  RECOVERING: ["READY", "VERIFYING", "WAITING_USER", "FAILED_FINAL"],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  const allowed = TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/** PAUSED：允许任意非终态转过去（文档写“任意非终态 → PAUSED”），手动恢复 */
export function canPauseTransition(from: TaskStatus): boolean {
  return !TERMINAL_STATUSES.has(from) && from !== "RECOVERING" && from !== "PAUSED";
}

export function canCancelTransition(from: TaskStatus): boolean {
  return !TERMINAL_STATUSES.has(from);
}
