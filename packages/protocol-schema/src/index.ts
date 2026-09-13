/**
 * App Server 协议层类型。
 *
 * 注意：本文件仅在启动阶段提供「引导类型」。生产协议类型必须由
 *   codex app-server generate-json-schema --out <dir>
 * 生成，并在合同测试中校验（见 scripts/generate-schema.ts）。
 * 此处只定义当前已用到的方法名与额度数据模型，版本升级时以生成结果为准。
 */

/** 当前已知的方法名（仅列举已使用的方法） */
export type AppServerMethod =
  | "initialize"
  | "initialized"
  | "account/read"
  | "account/rateLimits/read"
  | "account/rateLimitResetCredit/consume"
  | "thread/start"
  | "thread/resume"
  | "thread/read"
  | "thread/list"
  | "thread/fork"
  | "turn/start"
  | "turn/interrupt";

/** 通用 JSON-RPC 请求 */
export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: P;
}

/** 通用 JSON-RPC 通知（无 id） */
export interface JsonRpcNotification<P = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: P;
}

/** 服务端发起的请求（审批等） */
export interface JsonRpcServerRequest<P = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: P;
}

/** 通用 JSON-RPC 响应 */
export interface JsonRpcResponse<R = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  result?: R;
  error?: { code: number; message: string; data?: unknown };
}

/* ----------------------------- account/read ----------------------------- */

/** account/read 返回（v0.142.3 实测结构） */
export interface AccountInfo {
  account?: {
    type?: string;
    email?: string;
    planType?: string;
  };
  requiresOpenaiAuth?: boolean;
  [k: string]: unknown;
}

/** 单个额度窗口 */
export interface RateLimitWindow {
  usedPercent: number | null;
  windowDurationMins: number | null;
  /** Unix 秒级时间戳，下一次恢复时间 */
  resetsAt: number | null;
}

/** 额度积分信息 */
export interface RateLimitCredits {
  hasCredits?: boolean;
  unlimited?: boolean;
  balance?: string | number | null;
}

/** 单个额度桶（v0.142.3 实测：含 primary/secondary 双窗口 + credits/planType/individualLimit） */
export interface RateLimitBucketRaw {
  limitId?: string;
  limitName?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  credits?: RateLimitCredits | null;
  individualLimit?: unknown;
  planType?: string | null;
  rateLimitReachedType?: string | null;
}

/** 重置积分（rateLimitResetCredits） */
export interface RateLimitResetCredits {
  availableCount?: number;
}

/**
 * account/rateLimits/read 返回（v0.142.3 实测）：
 *   rateLimits: 单个桶对象（v0.142.3 不是数组），保留联合类型以兼容历史/未来
 *   rateLimitsByLimitId: 以 limitId 为键的桶映射
 *   rateLimitResetCredits: 可用重置积分数
 * 兼容旧文档里顶层 usedPercent/resetsAt（未必存在，仅作容错）
 */
export interface RateLimitsResult {
  rateLimits?: RateLimitBucketRaw | RateLimitBucketRaw[] | Record<string, RateLimitBucketRaw>;
  rateLimitsByLimitId?: Record<string, RateLimitBucketRaw>;
  rateLimitResetCredits?: RateLimitResetCredits;
  /** 旧版兼容顶层字段，常为不存在 */
  usedPercent?: number | null;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
  rateLimitReachedType?: string | null;
}

/* ---------------------- 线程 / 回合（v0.142.3 实测） ---------------------- */

/** SandboxMode（thread/start 的 sandbox；turn/start 的 sandboxPolicy 用更丰富结构） */
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** AskForApproval（approvalPolicy 字段）— 字符串枚举 or granular 对象 */
export type AskForApproval =
  | "untrusted"
  | "on-failure"
  | "on-request"
  | "never"
  | { granular: { mcp_elicitations: boolean; rules: boolean; sandbox_approval: boolean; request_permissions?: boolean; skill_approval?: boolean } };

/** ApprovalsReviewer */
export type ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";

/** UserInput：turn/start 的 input 数组项 */
export interface UserInputText { type: "text"; text: string; text_elements?: unknown[] }

/** thread/start 参数 */
export interface ThreadStartParams {
  cwd?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  sandbox?: SandboxMode | null;
  approvalPolicy?: AskForApproval | null;
  approvalsReviewer?: ApprovalsReviewer | null;
  personality?: "none" | "friendly" | "pragmatic" | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  serviceTier?: string | null;
  serviceName?: string | null;
  sessionStartSource?: string | null;
  threadSource?: string | null;
  config?: Record<string, unknown> | null;
  ephemeral?: boolean | null;
}

/** turn/start 参数 */
export interface TurnStartParams {
  threadId: string;
  input: UserInputText[];
  cwd?: string | null;
  model?: string | null;
  effort?: string | null;
  summary?: unknown | null;
  serviceTier?: string | null;
  personality?: "none" | "friendly" | "pragmatic" | null;
  sandboxPolicy?: { type: "workspaceWrite"; networkAccess?: boolean; writableRoots?: string[] } | { type: "readOnly"; networkAccess?: boolean } | { type: "dangerFullAccess" } | null;
  approvalPolicy?: AskForApproval | null;
  approvalsReviewer?: ApprovalsReviewer | null;
  outputSchema?: unknown;
  clientUserMessageId?: string | null;
}

/** thread/resume 参数 */
export interface ThreadResumeParams {
  threadId: string;
  cwd?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  sandbox?: SandboxMode | null;
  approvalPolicy?: AskForApproval | null;
  approvalsReviewer?: ApprovalsReviewer | null;
  personality?: "none" | "friendly" | "pragmatic" | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  serviceTier?: string | null;
  config?: Record<string, unknown> | null;
}

/**
 * thread/fork 参数（v0.153.4 实测：必填只有 threadId）。
 *
 * 语义：从已有线程派生一条**独立可写**的新线程。新线程通过血缘继承父线程的历史上下文，
 * 但两条线程的 writer 互不相干 —— 因此当父线程正被**别的** Codex 进程（通常是常驻的桌面版）
 * 持有写锁时，fork 依然可用。这正是 CAR 在 writer conflict 时的降级路径。
 *
 * excludeTurns 用于避免把父线程全量 turns 塞进响应（父线程 rollout 可达数 MB，
 * 会撞 AppServerClient 的 maxMessageBytes）；血缘由服务端建立，与响应是否带 turns 无关。
 */
export interface ThreadForkParams {
  threadId: string;
  /** fork through, inclusive —— 只分叉到该 turn 为止；缺省则分叉到父线程末尾 */
  lastTurnId?: string | null;
  /** 响应中不返回 turns（只要新线程 id 时应开启） */
  excludeTurns?: boolean | null;
  cwd?: string | null;
  model?: string | null;
  sandbox?: SandboxMode | null;
  approvalPolicy?: AskForApproval | null;
  approvalsReviewer?: ApprovalsReviewer | null;
}

/** thread/fork 返回（实测：thread 即新线程，其 forkedFromId 指向父线程） */
export interface ThreadForkResult {
  thread?: {
    id?: string;
    sessionId?: string;
    status?: { type?: string };
    /** 父线程 id —— 血缘标记 */
    forkedFromId?: string | null;
    turns?: unknown[];
  } | null;
  [k: string]: unknown;
}

/** thread/read 参数 */
export interface ThreadReadParams { threadId: string; includeTurns?: boolean }

/** thread/list 参数 */
export interface ThreadListParams {
  cwd?: string | string[] | null;
  archived?: boolean | null;
  searchTerm?: string | null;
  cursor?: string | null;
  limit?: number | null;
  sortDirection?: "asc" | "desc" | null;
  sortKey?: "created_at" | "updated_at" | "recency_at" | null;
  sourceKinds?: string[] | null;
  modelProviders?: string[] | null;
  useStateDbOnly?: boolean;
}

/** Turn 状态 */
export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

/** CodexErrorInfo（字符串变体） */
export type CodexErrorInfo =
  | "contextWindowExceeded" | "usageLimitExceeded" | "serverOverloaded" | "cyberPolicy"
  | "internalServerError" | "unauthorized" | "badRequest" | "threadRollbackFailed"
  | "sandboxError" | "other"
  | Record<string, unknown>;

/** TurnError */
export interface TurnError {
  message: string;
  additionalDetails?: string | null;
  codexErrorInfo?: CodexErrorInfo | null;
}

/** turn/completed 通知里的 turn 摘要 */
export interface TurnSummary {
  id: string;
  status: TurnStatus;
  items: unknown[];
  itemsView?: "notLoaded" | "summary" | "full";
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
  error?: TurnError | null;
}
