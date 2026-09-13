#!/usr/bin/env node
/**
 * car-mcp —— Codex Auto Runner 的 MCP 薄桥。
 *
 * 设计约束（重要）：
 *   1. 零依赖。只用 Node 内置模块，不引 MCP SDK —— 插件要能被 Codex 在任意
 *      工作目录、任意 Node 版本下直接 spawn，装依赖是最脆的一环。
 *   2. stdout 只走 JSON-RPC。任何日志/调试信息一律走 stderr，
 *      否则会污染 stdio 传输，Codex 侧解析直接失败。
 *   3. 不碰 daemon 的进程与数据库。本服务只是一个「HTTP 客户端」，
 *      所有读写都通过 daemon 已有的 127.0.0.1 HTTP API + token 进行。
 *      —— 因此它不会与正在跑的 daemon 争抢 runner.db，也不会误杀进程。
 *   4. 启动即就绪，不做任何阻塞式 I/O（不读大文件、不连网）。
 *      Codex 有 startup_timeout_sec；卡住会让它降级。
 *
 * 连接发现：
 *   <CAR_DATA_DIR>/api.json     → { baseUrl, port, tokenFile }
 *   <CAR_DATA_DIR>/car-api.token → token 明文
 *   CAR_DATA_DIR 默认 %LOCALAPPDATA%\CodexAutoRunner\data，可用环境变量覆盖。
 *
 * 手写握手自检：node _audit/probe-mcp.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "car-mcp";
const SERVER_VERSION = "0.1.0";

/* ────────────────────────── 连接发现 ────────────────────────── */

function resolveDataDir() {
  if (process.env.CAR_DATA_DIR) return process.env.CAR_DATA_DIR;
  return join(os.homedir(), "AppData", "Local", "CodexAutoRunner", "data");
}

function readConn() {
  const dataDir = resolveDataDir();
  const apiFile = join(dataDir, "api.json");
  if (!existsSync(apiFile)) {
    throw new Error(
      `找不到 CAR 数据目录 (${dataDir})。daemon 未启动？请先运行 codex-auto-runner 的 daemon。`,
    );
  }
  let api;
  try {
    api = JSON.parse(readFileSync(apiFile, "utf8"));
  } catch (e) {
    throw new Error(`api.json 解析失败: ${e.message}`);
  }
  const tokenFile = join(dataDir, api.tokenFile ?? "car-api.token");
  if (!existsSync(tokenFile)) throw new Error(`token 文件缺失: ${tokenFile}`);
  const token = readFileSync(tokenFile, "utf8").trim();
  if (!api.baseUrl || !token) throw new Error("api.json 缺少 baseUrl 或 token 为空");
  return { dataDir, baseUrl: api.baseUrl, port: api.port, token };
}

async function carFetch(pathname, { method = "GET", body, timeoutMs = 30_000 } = {}) {
  const conn = readConn();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(conn.baseUrl + pathname, {
      method,
      headers: {
        "X-Car-Token": conn.token,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { _raw: text };
    }
    if (!res.ok) {
      const detail = text ? text.slice(0, 800) : "(empty body)";
      throw new Error(`CAR API ${method} ${pathname} → HTTP ${res.status}: ${detail}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/* ────────────────────────── 工具定义 ────────────────────────── */

const S = {
  str: (desc, extra = {}) => ({ type: "string", description: desc, ...extra }),
  num: (desc, extra = {}) => ({ type: "number", description: desc, ...extra }),
  bool: (desc, extra = {}) => ({ type: "boolean", description: desc, ...extra }),
};

const TOOLS = [
  {
    name: "car_ping",
    description:
      "Ping the locally running Codex Auto Runner daemon. Returns ok if reachable. Use this first to confirm the daemon is up.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => carFetch("/healthz"),
  },
  {
    name: "car_status",
    description:
      "Read the CAR overview: quota snapshot (5h / weekly buckets, reset time), auto-run switch, task list summary, and running/ready counts.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => carFetch("/api/status"),
  },
  {
    name: "car_quota",
    description: "Read detailed quota buckets plus recent quota history snapshots.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => carFetch("/api/quota"),
  },
  {
    name: "car_tasks",
    description:
      "List managed tasks. Each entry includes status, priority, threadId, cycle counters, nextRunAt, and the quota-interrupt markers (lastQuotaInterruptedAt / lastQuotaInterruptedThreadId).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => carFetch("/api/tasks"),
  },
  {
    name: "car_task_get",
    description: "Get one task in detail, including its run history.",
    inputSchema: {
      type: "object",
      properties: { id: S.str("Task id, e.g. task_8yr11tsumtypwyr8") },
      required: ["id"],
      additionalProperties: false,
    },
    handler: async ({ id }) => carFetch(`/api/tasks/${encodeURIComponent(id)}`),
  },
  {
    name: "car_task_create",
    description:
      "Create a managed task. Use mode=resume_thread with threadId to take over and resume an existing Codex thread (e.g. one that was interrupted by the 5h limit). This WRITES state.",
    inputSchema: {
      type: "object",
      properties: {
        title: S.str("Human-readable task title"),
        projectPath: S.str("Absolute working directory for the task"),
        originalGoal: S.str("The goal / instruction for the agent"),
        resumeInstruction: S.str("Optional extra instruction used when resuming a thread"),
        priority: S.num("Scheduling priority, higher runs first (default 50)"),
        mode: S.str("new_thread | resume_thread | imported_thread", { enum: ["new_thread", "resume_thread", "imported_thread"] }),
        threadId: S.str("Existing Codex thread id (required when mode=resume_thread)"),
        sandboxMode: S.str("readOnly | workspaceWrite", { enum: ["readOnly", "workspaceWrite"] }),
        networkAccess: S.bool("Allow network access inside the run"),
        approvalMode: S.str("safe_autonomous | interactive", { enum: ["safe_autonomous", "interactive"] }),
        workspaceMode: S.str("direct | worktree", { enum: ["direct", "worktree"] }),
        maxRunCycles: S.num("Max run cycles"),
        maxQuotaCycles: S.num("Max quota-recovery cycles"),
        maxRetryCount: S.num("Max retries"),
        useResetCreditOnWeeklyLimit: S.bool("Consume a rate-limit reset credit when the weekly bucket is exhausted"),
      },
      required: ["title", "projectPath", "originalGoal"],
      additionalProperties: false,
    },
    handler: async (a) => carFetch("/api/tasks", { method: "POST", body: a }),
  },
  {
    name: "car_task_action",
    description:
      "Control one task: pause | resume | run-now | cancel. 'run-now' forces the task READY with nextRunAt=now so the scheduler picks it up immediately. This WRITES state.",
    inputSchema: {
      type: "object",
      properties: {
        id: S.str("Task id"),
        action: S.str("pause | resume | run-now | cancel", { enum: ["pause", "resume", "run-now", "cancel"] }),
      },
      required: ["id", "action"],
      additionalProperties: false,
    },
    handler: async ({ id, action }) =>
      carFetch(`/api/tasks/${encodeURIComponent(id)}/${action}`, { method: "POST" }),
  },
  {
    name: "car_sessions",
    description:
      "List Codex threads known to the daemon, annotated with goal state and — crucially — whether each was interrupted by the 5h limit. This is the list to pick a resume target from.",
    inputSchema: {
      type: "object",
      properties: { limit: S.num("Max threads to return (1-50, default 20)") },
      additionalProperties: false,
    },
    handler: async ({ limit } = {}) => {
      const q = limit ? `?limit=${encodeURIComponent(limit)}` : "";
      return carFetch(`/api/codex/sessions${q}`, { timeoutMs: 60_000 });
    },
  },
  {
    name: "car_goal_activate",
    description:
      "Re-activate a stopped Codex thread goal (thread/goal/set status=active). Only works for threads that still have a goal object.",
    inputSchema: {
      type: "object",
      properties: { threadId: S.str("Codex thread id") },
      required: ["threadId"],
      additionalProperties: false,
    },
    handler: async ({ threadId }) => carFetch("/api/codex/goal/activate", { method: "POST", body: { threadId } }),
  },
  {
    name: "car_events",
    description: "Read the event log (quota changes, run transitions, reset-credit outcomes).",
    inputSchema: {
      type: "object",
      properties: {
        taskId: S.str("Optional: only events for this task"),
        limit: S.num("Max events (default 200)"),
        since: S.num("Only events with id greater than this"),
      },
      additionalProperties: false,
    },
    handler: async ({ taskId, limit, since } = {}) => {
      const p = new URLSearchParams();
      if (taskId) p.set("taskId", taskId);
      if (limit != null) p.set("limit", String(limit));
      if (since != null) p.set("since", String(since));
      const q = p.toString();
      return carFetch(`/api/events${q ? "?" + q : ""}`);
    },
  },
  {
    name: "car_settings_get",
    description: "Read the auto-run switch.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => carFetch("/api/settings"),
  },
  {
    name: "car_settings_set",
    description:
      "Turn the daemon auto-run switch on/off. When off, the scheduler will not claim any task. This WRITES state.",
    inputSchema: {
      type: "object",
      properties: { autoRunEnabled: S.bool("true to enable auto-run") },
      required: ["autoRunEnabled"],
      additionalProperties: false,
    },
    handler: async ({ autoRunEnabled }) =>
      carFetch("/api/settings", { method: "POST", body: { autoRunEnabled } }),
  },
  {
    name: "car_console_url",
    description:
      "Return the URL of the CAR web console running on the local daemon. Useful to tell the user where to look.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const conn = readConn();
      return { consoleUrl: conn.baseUrl + "/", port: conn.port, dataDir: conn.dataDir };
    },
  },
];

const TOOL_INDEX = new Map(TOOLS.map((t) => [t.name, t]));

/* ────────────────────────── JSON-RPC / MCP ────────────────────────── */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

function log(...args) {
  process.stderr.write("[car-mcp] " + args.map(String).join(" ") + "\n");
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;

    case "notifications/initialized":
    case "initialized":
      return; // notification, no reply

    case "ping":
      reply(id, {});
      return;

    case "tools/list":
      reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
      return;

    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const tool = TOOL_INDEX.get(name);
      if (!tool) {
        replyError(id, -32602, `未知工具: ${name}`);
        return;
      }
      try {
        const out = await tool.handler(args);
        reply(id, {
          content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }],
          isError: false,
        });
      } catch (e) {
        // 工具级错误按 MCP 约定返回 isError，而不是 JSON-RPC error
        reply(id, {
          content: [{ type: "text", text: `car-mcp 调用失败: ${e?.message ?? String(e)}` }],
          isError: true,
        });
      }
      return;
    }

    case "resources/list":
      reply(id, { resources: [] });
      return;

    case "prompts/list":
      reply(id, { prompts: [] });
      return;

    default:
      if (!isNotification) replyError(id, -32601, `未实现的方法: ${method}`);
      return;
  }
}

function main() {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        log("无法解析的输入行:", line.slice(0, 200));
        continue;
      }
      // 并发处理：工具调用可能 await fetch，不能阻塞后续消息
      void handle(msg).catch((e) => {
        log("handle threw:", e?.message ?? String(e));
        if (msg && msg.id !== undefined && msg.id !== null) {
          replyError(msg.id, -32603, String(e?.message ?? e));
        }
      });
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  log(`ready (pid=${process.pid}, dataDir=${resolveDataDir()})`);
}

main();
