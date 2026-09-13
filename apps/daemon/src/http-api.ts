/**
 * HTTP API —— 仅监听 127.0.0.1，本地 token 鉴权。
 *
 * 路由：
 *   GET  /api/status            额度快照 + 任务概览
 *   GET  /api/quota             额度详情（含历史）
 *   GET  /api/tasks             任务列表
 *   GET  /api/tasks/:id         任务详情（含 runs）
 *   POST /api/tasks             创建任务（JSON body）
 *   GET  /api/codex/sessions    Codex 会话 + 目标状态
 *   POST /api/codex/goal/activate  激活已停止目标
 *   POST /api/tasks/:id/pause
 *   POST /api/tasks/:id/resume
 *   POST /api/tasks/:id/run-now
 *   POST /api/tasks/:id/cancel
 *   GET  /api/events?taskId=&limit=&since=
 *   GET  /api/settings
 *   POST /api/settings          { autoRunEnabled }
 *
 * 鉴权：仅 /api/* 需要请求头 X-Car-Token（匹配 dataDir/car-api.token，首启随机生成，ACL 限本用户）。
 *       静态资源与 /healthz 放行——浏览器无法为页面/脚本请求附加自定义头。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { SqliteRepository, TERMINAL_STATUSES, type CreateTaskInput, type ManagedTask } from "@car/persistence";
import { toMillis } from "./time.js";
import type { QuotaSnapshot } from "@car/quota-engine";
import type { Logger } from "@car/logger";
import type { AppServerClient } from "@car/app-server-client";

export interface HttpApiDeps {
  repo: SqliteRepository;
  client: AppServerClient;
  dataDir: string;
  logger: Logger;
  getQuotaSnapshot: () => QuotaSnapshot | null;
  getAutoRun: () => boolean;
  setAutoRun: (v: boolean) => void;
  /**
   * 可选：web 静态资源目录（生产 serve 前端）。
   * 做成惰性函数而非启动时定值——`apps/web/dist` 常常在 daemon 之后才 build 出来，
   * 若只在启动时解析一次，之后 build 也不生效，必须重启 daemon 才能看到前端。
   * 未命中时应返回 undefined 并在下次请求重试，命中后再由调用方自行缓存。
   */
  getWebDir?: () => string | undefined;
  /** @deprecated 用 getWebDir；保留仅为兼容旧调用 */
  webDir?: string;
}

export function startHttpApi(deps: HttpApiDeps, port = 0): Promise<{ port: number; token: string; baseUrl: string; close: () => void }> {
  const { repo, dataDir, logger } = deps;
  mkdirSync(dataDir, { recursive: true });
  const tokenFile = join(dataDir, "car-api.token");
  let token: string;
  if (existsSync(tokenFile)) {
    token = readFileSync(tokenFile, "utf8").trim();
  } else {
    token = randomBytes(24).toString("hex");
    writeFileSync(tokenFile, token, { encoding: "utf8" });
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      logger.error("http error", { err: String(e), url: req.url });
      sendJson(res, 500, { error: String(e) });
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      logger.info("http api listening", { port: actualPort, baseUrl: `http://127.0.0.1:${actualPort}` });
      resolve({ port: actualPort, token, baseUrl: `http://127.0.0.1:${actualPort}`, close: () => server.close() });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    // CORS（dev 时 vite 代理可绕过；直连时也允许）
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Car-Token");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") { sendJson(res, 204, null); return; }

    // 鉴权：只覆盖 /api/*。
    // 静态资源（SPA 外壳）是浏览器直接加载的，无法附加自定义请求头，
    // 若一并纳入鉴权，生产模式下打开页面必然 401。服务只监听 127.0.0.1，
    // 且静态产物不含任何机密，放行是安全的；数据与操作仍全部走 /api/*。
    if (path.startsWith("/api/")) {
      const t = req.headers["x-car-token"];
      if (t !== token) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
    }

    // 静态前端（生产）
    const webDir = deps.getWebDir ? deps.getWebDir() : deps.webDir;
    if (webDir && (req.method === "GET") && !path.startsWith("/api/") && path !== "/healthz") {
      return serveStatic(webDir, path, res);
    }

    if (path === "/healthz") return sendJson(res, 200, { ok: true });

    // /api/status
    if (path === "/api/status" && req.method === "GET") {
      const snap = effectiveQuotaSnapshot(repo, deps.getQuotaSnapshot());
      const tasks = repo.listTasks();
      return sendJson(res, 200, {
        quota: snap,
        autoRun: deps.getAutoRun(),
        tasks: tasks.map(summary),
        taskCount: tasks.length,
        runningCount: tasks.filter((t) => ["PREPARING", "STARTING_THREAD", "RUNNING", "VERIFYING", "CANCELLING", "RECOVERING"].includes(t.status)).length,
        readyCount: tasks.filter((t) => t.status === "READY").length,
      });
    }

    if (path === "/api/quota" && req.method === "GET") {
      const snap = effectiveQuotaSnapshot(repo, deps.getQuotaSnapshot());
      const history = repo.listQuotaSnapshots(50);
      return sendJson(res, 200, { current: snap, history });
    }

    if (path === "/api/tasks" && req.method === "GET") {
      return sendJson(res, 200, repo.listTasks().map(summary));
    }

    if (path === "/api/tasks" && req.method === "POST") {
      const body = await readJson(req);
      const input = normalizeTaskInput(body);
      const t = repo.createTask(input);
      return sendJson(res, 201, t);
    }

    if (path === "/api/codex/sessions" && req.method === "GET") {
      const limit = Math.min(numOr(url.searchParams.get("limit"), 20), 50);
      // 第 3 项：把「被打断线程 → 时间/任务」索引从 repo 取出，用于排序与角标。
      // 每次请求现算，保证刚被打断的线程立刻反映到排序里。
      const quotaIndex = buildQuotaInterruptIndex(repo);
      return sendJson(res, 200, await listCodexSessions(deps.client, limit, quotaIndex));
    }

    if (path === "/api/codex/goal/activate" && req.method === "POST") {
      const body = await readJson(req);
      const threadId = String(body.threadId ?? "");
      if (!threadId) return sendJson(res, 400, { error: "threadId required" });
      const current = await getThreadGoal(deps.client, threadId);
      if (!current) return sendJson(res, 404, { error: "goal not found" });
      const activated = await deps.client.request("thread/goal/set", {
        threadId,
        objective: current.objective,
        status: "active",
        tokenBudget: current.tokenBudget ?? null,
      });
      return sendJson(res, 200, activated);
    }

    const taskMatch = path.match(/^\/api\/tasks\/([^/]+)(?:\/(pause|resume|run-now|cancel))?$/);
    if (taskMatch) {
      const id = taskMatch[1] as string;
      const action = taskMatch[2];
      const t = repo.getTask(id);
      if (!t) return sendJson(res, 404, { error: "task not found" });
      if (action && req.method === "POST") {
        if (action === "pause") repo.forceStatus(id, "PAUSED");
        else if (action === "resume" || action === "run-now") {
          repo.forceStatus(id, "READY");
          repo.patch(id, { nextRunAt: Date.now() });
        } else if (action === "cancel") repo.forceStatus(id, "CANCELLED");
        const updated = repo.getTask(id);
        return sendJson(res, 200, updated);
      }
      if (!action && req.method === "GET") {
        const runs = repo.listRuns(id);
        return sendJson(res, 200, { ...t, runs });
      }
    }

    if (path === "/api/events" && req.method === "GET") {
      const taskId = url.searchParams.get("taskId") ?? undefined;
      const limit = numOr(url.searchParams.get("limit"), 200);
      const since = numOr(url.searchParams.get("since"), 0);
      return sendJson(res, 200, repo.listEvents({ taskId, limit, since }));
    }

    if (path === "/api/settings" && req.method === "GET") {
      return sendJson(res, 200, { autoRunEnabled: deps.getAutoRun() });
    }
    if (path === "/api/settings" && req.method === "POST") {
      const body = await readJson(req);
      if (typeof body.autoRunEnabled === "boolean") deps.setAutoRun(body.autoRunEnabled);
      return sendJson(res, 200, { autoRunEnabled: deps.getAutoRun() });
    }

    sendJson(res, 404, { error: "not found", path });
  }
}

function effectiveQuotaSnapshot(repo: SqliteRepository, snap: QuotaSnapshot | null): QuotaSnapshot | null {
  if (!snap || snap.status !== "unknown" || snap.buckets.length > 0 || snap.usedPercent != null) return snap;
  const recent = repo.listQuotaSnapshots(50).find((row) => row.used_percent != null && row.status !== "unknown");
  if (!recent) return snap;
  const usedPercent = Number(recent.used_percent);
  return {
    ...snap,
    status: recent.status as QuotaSnapshot["status"],
    usedPercent,
    capturedAt: recent.captured_at,
    nextEligibleAt: recent.next_eligible_at,
    buckets: [{
      limitId: "codex",
      limitName: null,
      primary: { usedPercent, windowDurationMins: null, resetsAt: recent.next_eligible_at ? Math.floor(recent.next_eligible_at / 1000) : null },
      secondary: null,
      credits: null,
      planType: null,
      rateLimitReachedType: null,
    }],
    blockingBuckets: [],
  };
}

function summary(t: ManagedTask) {
  return {
    id: t.id, title: t.title, status: t.status, priority: t.priority,
    threadId: t.threadId, projectPath: t.projectPath, mode: t.mode,
    runCycleCount: t.runCycleCount, maxRunCycles: t.maxRunCycles,
    quotaCycleCount: t.quotaCycleCount, maxQuotaCycles: t.maxQuotaCycles,
    retryCount: t.retryCount, maxRetryCount: t.maxRetryCount,
    nextRunAt: t.nextRunAt, quotaResetAt: t.quotaResetAt,
    lastError: t.lastError, lastProgressHash: t.lastProgressHash,
    stagnantCycleCount: t.stagnantCycleCount,
    createdAt: t.createdAt, updatedAt: t.updatedAt, startedAt: t.startedAt, finishedAt: t.finishedAt,
    terminal: TERMINAL_STATUSES.has(t.status),
    acceptanceCriteria: t.acceptanceCriteria, validationCommands: t.validationCommands,
    originalGoal: t.originalGoal, sandboxMode: t.sandboxMode, networkAccess: t.networkAccess,
    approvalMode: t.approvalMode, workspaceMode: t.workspaceMode,
    useResetCreditOnWeeklyLimit: t.useResetCreditOnWeeklyLimit,
    resetCreditLastAttemptAt: t.resetCreditLastAttemptAt,
    resetCreditLastOutcome: t.resetCreditLastOutcome,
    // 第 2/6 项产物：任务级的「被额度打断」标记，前端任务列表同样可用
    lastQuotaInterruptedAt: t.lastQuotaInterruptedAt,
    lastQuotaInterruptedThreadId: t.lastQuotaInterruptedThreadId,
  };
}

interface CodexThreadSummary {
  id: string;
  sessionId: string | null;
  name: string | null;
  preview: string;
  cwd: string | null;
  source: string | null;
  updatedAt: number | null;
  createdAt: number | null;
  status: string;
  loaded: boolean;
  goal: CodexGoal | null;
  /**
   * 该线程最近一次因 5h/周额度被打断的时间（来自 tasks 表，不依赖 goal）。
   * - 有值 → 前端可打「上次因 5h 限额中断」角标，并优先选中；
   * - 无 goal 的线程同样会有值 —— 这是本次修复的关键。
   */
  quotaInterruptedAt: number | null;
  /** 该线程最近一次被打断时所属的任务 id（便于前端一键续跑同一个任务）。 */
  quotaInterruptedTaskId: string | null;
}

interface CodexGoal {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  updatedAt?: number;
}

/** 「被打断线程」查询索引：threadId -> { at, taskId } */
interface QuotaInterruptIndex {
  byThread: Map<string, { at: number; taskId: string }>;
}

/**
 * 从持久层构造「被额度打断」的线程索引。
 *
 * 之所以放在应用层而不是直接依赖 goal：无 goal 线程的 goal 为 null，
 * 唯一可靠的识别信号就是 tasks 表的 last_quota_interrupted_* 字段。
 */
function buildQuotaInterruptIndex(repo: SqliteRepository): QuotaInterruptIndex {
  const byThread = new Map<string, { at: number; taskId: string }>();
  try {
    for (const t of repo.listTasks()) {
      const tid = t.lastQuotaInterruptedThreadId;
      const at = t.lastQuotaInterruptedAt;
      if (!tid || at == null) continue;
      const prev = byThread.get(tid);
      if (!prev || at > prev.at) byThread.set(tid, { at, taskId: t.id });
    }
  } catch {
    // 索引构造失败不应影响会话列表本身可用性
  }
  return { byThread };
}

async function listCodexSessions(
  client: AppServerClient,
  limit: number,
  quotaIndex?: QuotaInterruptIndex,
): Promise<{ sessions: CodexThreadSummary[] }> {
  const loaded = await client.request<{ data?: string[] }>("thread/loaded/list", {}).catch(() => ({ data: [] }));
  const loadedIds = new Set(loaded.data ?? []);
  const listed = await client.request<{ data?: unknown[] }>("thread/list", {
    limit,
    sortDirection: "desc",
    sortKey: "recency_at",
  });
  const byId = new Map<string, unknown>();
  for (const t of listed.data ?? []) {
    const id = readString(t, "id");
    if (id) byId.set(id, t);
  }
  for (const id of loadedIds) {
    if (!byId.has(id)) {
      const read = await client.request<{ thread?: unknown }>("thread/read", { threadId: id, includeTurns: false }).catch(() => null);
      if (read?.thread) byId.set(id, read.thread);
    }
  }

  const sessions: CodexThreadSummary[] = [];
  for (const t of byId.values()) {
    const id = readString(t, "id");
    if (!id) continue;
    const goal = await getThreadGoal(client, id);
    const hit = quotaIndex?.byThread.get(id);
    sessions.push({
      id,
      sessionId: readString(t, "sessionId"),
      name: readString(t, "name"),
      preview: readString(t, "preview") ?? "",
      cwd: readString(t, "cwd"),
      source: readString(t, "source"),
      updatedAt: toMillis(readNumber(t, "updatedAt")),
      createdAt: toMillis(readNumber(t, "createdAt")),
      status: readNestedString(t, "status", "type") ?? "unknown",
      loaded: loadedIds.has(id),
      goal,
      quotaInterruptedAt: hit?.at ?? null,
      quotaInterruptedTaskId: hit?.taskId ?? null,
    });
  }

  // 第 3 项：排序改为「最近被打断优先」。
  // 原来 loaded 排在最前，导致刚被 5h 限额打断、但当前未 loaded 的线程被挤到后面，
  // 用户（以及前端默认选中）就会挑中错误的线程。
  // 新序：① 是否被额度打断过 → ② 打断时间新者优先 → ③ loaded → ④ 最近更新。
  sessions.sort((a, b) => {
    const aHit = a.quotaInterruptedAt != null ? 1 : 0;
    const bHit = b.quotaInterruptedAt != null ? 1 : 0;
    if (aHit !== bHit) return bHit - aHit;
    if (aHit && bHit) {
      const d = (b.quotaInterruptedAt ?? 0) - (a.quotaInterruptedAt ?? 0);
      if (d !== 0) return d;
    }
    const ld = Number(b.loaded) - Number(a.loaded);
    if (ld !== 0) return ld;
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });
  return { sessions: sessions.slice(0, limit) };
}

async function getThreadGoal(client: AppServerClient, threadId: string): Promise<CodexGoal | null> {
  const resp = await client.request<{ goal?: CodexGoal | null }>("thread/goal/get", { threadId }).catch(() => null);
  return resp?.goal ?? null;
}

function readString(obj: unknown, key: string): string | null {
  if (!obj || typeof obj !== "object") return null;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

function readNumber(obj: unknown, key: string): number | null {
  if (!obj || typeof obj !== "object") return null;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "number" ? v : null;
}

function readNestedString(obj: unknown, key: string, nested: string): string | null {
  if (!obj || typeof obj !== "object") return null;
  const child = (obj as Record<string, unknown>)[key];
  return readString(child, nested);
}

function normalizeTaskInput(b: any): CreateTaskInput {
  return {
    title: String(b.title ?? "untitled"),
    projectPath: String(b.projectPath ?? process.cwd()),
    originalGoal: String(b.originalGoal ?? b.goal ?? ""),
    resumeInstruction: b.resumeInstruction ?? "",
    acceptanceCriteria: Array.isArray(b.acceptanceCriteria) ? b.acceptanceCriteria : [],
    priority: numOr(b.priority, 50),
    mode: (b.mode === "resume_thread" || b.mode === "imported_thread") ? b.mode : "new_thread",
    threadId: b.threadId ?? null,
    model: b.model ?? null,
    sandboxMode: b.sandboxMode === "readOnly" ? "readOnly" : "workspaceWrite",
    networkAccess: !!b.networkAccess,
    approvalMode: b.approvalMode === "interactive" ? "interactive" : "safe_autonomous",
    workspaceMode: b.workspaceMode === "worktree" ? "worktree" : "direct",
    validationCommands: Array.isArray(b.validationCommands) ? b.validationCommands : [],
    maxRunCycles: numOr(b.maxRunCycles, 5),
    maxQuotaCycles: numOr(b.maxQuotaCycles, 10),
    useResetCreditOnWeeklyLimit: !!b.useResetCreditOnWeeklyLimit,
    maxRetryCount: numOr(b.maxRetryCount, 3),
  };
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body == null ? "" : JSON.stringify(body));
}

function numOr(v: unknown, def: number): number {
  if (v == null) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

async function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => { buf += c; if (buf.length > 1_000_000) { reject(new Error("body too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * 把请求路径映射为 webDir 内的绝对文件路径。
 *
 * 静态资源免鉴权后任何本机进程都能访问，因此必须确认映射结果仍位于 webDir 内，
 * 否则 `/../../` 之类的路径就能读到 dist 之外的文件。越界返回 null。
 *
 * 注：常规 `..` / `%2e%2e` 段会被 WHATWG URL 解析提前折叠，这里是兜底。
 */
export function resolveStaticPath(webDir: string, path: string): string | null {
  const root = resolve(webDir);
  const rel = path === "/" ? "/index.html" : path;
  const target = resolve(root, "." + rel);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

async function serveStatic(webDir: string, path: string, res: ServerResponse): Promise<void> {
  const root = resolve(webDir);
  const p = resolveStaticPath(webDir, path);
  if (p === null) {
    sendJson(res, 403, { error: "forbidden", path });
    return;
  }
  try {
    const data = await readFile(p);
    res.writeHead(200, { "Content-Type": MIME[extname(p)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    // SPA fallback
    try {
      const data = await readFile(join(root, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    } catch {
      sendJson(res, 404, { error: "not found", path });
    }
  }
}
