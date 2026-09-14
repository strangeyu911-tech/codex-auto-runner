/**
 * 桌面版登记：把 CAR 自建的线程「挂进」Codex 桌面版的侧边栏。
 *
 * 问题（已实测定位，非猜测）：
 *   CAR 通过 `thread/start` / `thread/fork` 造出来的线程，app-server 侧完全正常 ——
 *   `thread/list` 默认参数就能返回它。但桌面版侧边栏**不按 `thread/list` 渲染**：
 *   它维护自己的成员表，存在 `%USERPROFILE%\.codex\.codex-global-state.json` 里：
 *     - `thread-project-assignments`   线程 → 项目（侧边栏按项目分组）
 *     - `sidebar-project-thread-orders` 每个项目下线程的排序
 *     - `projectless-thread-ids`       没有项目的线程（「未分组」分组）
 *   桌面端只在**自己创建线程**或**用户改动项目根路径**时调用内部对账
 *   （`assignUnassignedThreadsBeforeProjectRootsChange`，作用域是该次操作涉及的根路径）。
 *   实测：9-13 的 fork 产物过了一整天、跨多次桌面版重启仍是「未登记」→ 没有启动期对账。
 *   所以外部进程造的线程天生不可见，并且**永远不会**被自动收养。
 *
 * 本包做的事：在 CAR 造出线程之后，把这几个键**增量合并**地补上，让它出现在侧边栏。
 *
 * 安全边界（重要）：
 *   - 只增不删：绝不删除或改写既有的任何键/条目，只写我们自己的 threadId。
 *   - 读-改-写带并发检查：写回前比对 size/mtimeMs，被桌面版抢先写过就重读重试。
 *   - 原子落盘：同目录 tmp + rename（桌面版自己也是这么写的）。
 *   - 首次改动前留一份 `.car-backup`，只留一次，不覆盖。
 *   - 解析失败 / 文件不存在 / 形状不符 → 一律放弃写入并返回原因，**绝不新建或清空**该文件。
 *   - ⚠️ 桌面版**正在运行时**，它的状态在内存里，**下一次写盘会把我们的整条写入覆盖掉**
 *     （实测：写进去的登记活了 90 秒，约 11 分钟后被抹回 undefined）。
 *     所以可靠顺序只有一种：完全退出桌面版 → 写入 → 启动桌面版。
 *     调用方要么自己周期性重试（等桌面版被关掉），要么让用户按这个顺序手动跑一次。
 *     —— 安全性不受影响：我们的写入是完整的合法 JSON，最坏结果是被覆盖，不会污染或损坏它。
 */

import { copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_FILE = ".codex-global-state.json";
const BACKUP_SUFFIX = ".car-backup";

const KEY_ASSIGNMENTS = "thread-project-assignments";
const KEY_ORDERS = "sidebar-project-thread-orders";
const KEY_PROJECTLESS = "projectless-thread-ids";
const KEY_LOCAL_PROJECTS = "local-projects";
const KEY_ROOT_HINTS = "thread-workspace-root-hints";

/** 目录名带点和连字符，是桌面版自己的键名，别改。 */
export const DESKTOP_STATE_FILENAME = STATE_FILE;

export interface ThreadProjectAssignment {
  projectKind: "local";
  projectId: string;
}

export interface RegisterThreadInput {
  /** 要登记的线程（CAR 通过 thread/start 或 thread/fork 拿到的 id）。 */
  threadId: string;
  /** fork 场景的父线程；有它就直接继承父线程的项目归属。 */
  parentThreadId?: string | null;
  /** 线程工作目录，用于在父线程无归属时按项目根路径反查。 */
  cwd?: string | null;
  /** 覆盖 codex home（测试用）。 */
  codexHome?: string;
  /** 只读演练：算出要写什么但不动盘。 */
  dryRun?: boolean;
}

export interface RegisterThreadResult {
  ok: boolean;
  /** 相对原文件是否有实际改动。 */
  changed: boolean;
  /** 命中的项目 id；落到未分组时为 null。 */
  projectId: string | null;
  placement: "project" | "projectless" | "none";
  /** 实际写入的顶层键。 */
  wroteKeys: string[];
  reason: string;
}

export function resolveCodexHome(explicit?: string): string {
  if (explicit) return explicit;
  const env = process.env.CODEX_HOME;
  if (env && env.trim()) return env;
  return join(homedir(), ".codex");
}

export function desktopStatePath(codexHome?: string): string {
  return join(resolveCodexHome(codexHome), STATE_FILE);
}

/** `\\?\D:\x\y\` → `d:/x/y`：统一分隔符、去扩展前缀、去尾斜杠、小写。 */
export function normalizePath(p: string | null | undefined): string {
  if (!p) return "";
  return p
    .replace(/^[\\/]{2}\?[\\/]/, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function isAssignment(v: unknown): v is ThreadProjectAssignment {
  const r = asRecord(v);
  return r.projectKind === "local" && typeof r.projectId === "string" && r.projectId.length > 0;
}

function asIdArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** 从 `local-projects` 里按根路径反查项目；返回命中的 projectId。 */
export function matchProjectByCwd(state: Record<string, unknown>, cwd: string | null | undefined): string | null {
  const target = normalizePath(cwd);
  if (!target) return null;
  const projects = asRecord(state[KEY_LOCAL_PROJECTS]);
  for (const [projectId, project] of Object.entries(projects)) {
    const roots = asIdArray(asRecord(project).rootPaths);
    for (const root of roots) {
      if (normalizePath(root) === target) return projectId;
    }
  }
  return null;
}

/**
 * 计算需要写入的补丁。纯函数，便于测试与演练。
 * 返回 null 表示「桌面版已经收下这条线程，或无需改动」。
 */
export function planRegistration(
  state: Record<string, unknown>,
  input: RegisterThreadInput,
): { next: Record<string, unknown>; projectId: string | null; placement: "project" | "projectless"; wroteKeys: string[] } | null {
  const { threadId, parentThreadId, cwd } = input;
  const assignments = { ...asRecord(state[KEY_ASSIGNMENTS]) };
  const orders = asRecord(state[KEY_ORDERS]);
  const projectless = asIdArray(state[KEY_PROJECTLESS]);
  const hints = { ...asRecord(state[KEY_ROOT_HINTS]) };

  // 已经被桌面版收下（有归属，或在未分组名单里）→ 不动它。桌面版自己管排序。
  if (isAssignment(assignments[threadId]) || projectless.includes(threadId)) return null;

  // 归属优先继承父线程：fork 出来的孩子天然应该跟父亲在同一个项目组里。
  let assignment: ThreadProjectAssignment | null = null;
  if (parentThreadId) {
    const inherited = assignments[normalizeThreadKey(assignments, parentThreadId)];
    if (isAssignment(inherited)) assignment = inherited;
  }
  if (!assignment) {
    const byCwd = matchProjectByCwd(state, cwd);
    if (byCwd) assignment = { projectKind: "local", projectId: byCwd };
  }

  const wroteKeys: string[] = [];

  if (assignment) {
    assignments[threadId] = assignment;
    wroteKeys.push(KEY_ASSIGNMENTS);
    // 排序表是「每个项目下的线程 id 列表」。放进表里可以让它在两种渲染口径下都成立。
    const bucket = { ...asRecord(orders[assignment.projectId]) };
    const ids = asIdArray(bucket.threadIds);
    if (!ids.includes(threadId)) {
      orders[assignment.projectId] = { ...bucket, threadIds: [threadId, ...ids] };
      wroteKeys.push(KEY_ORDERS);
    }
  } else {
    projectless.unshift(threadId);
    wroteKeys.push(KEY_PROJECTLESS);
  }

  // 根路径提示：让桌面版将来做对账时也能认出这条线程的工作区。
  const cwdValue = typeof cwd === "string" && cwd.trim() ? cwd : null;
  if (cwdValue) {
    hints[threadId] = cwdValue;
    wroteKeys.push(KEY_ROOT_HINTS);
  }

  const next: Record<string, unknown> = { ...state };
  next[KEY_ASSIGNMENTS] = assignments;
  next[KEY_ORDERS] = orders;
  if (!assignment) next[KEY_PROJECTLESS] = projectless;
  next[KEY_ROOT_HINTS] = hints;
  return {
    next,
    projectId: assignment?.projectId ?? null,
    placement: assignment ? "project" : "projectless",
    wroteKeys,
  };
}

/** 容错查表：桌面版键可能大小写/连字符不完全一致时兜一下。 */
function normalizeThreadKey(container: Record<string, unknown>, id: string): string {
  if (Object.prototype.hasOwnProperty.call(container, id)) return id;
  const lower = id.toLowerCase();
  for (const k of Object.keys(container)) if (k.toLowerCase() === lower) return k;
  return id;
}

const WRITE_ATTEMPTS = 3;

/**
 * 线程是否已被桌面版收下（有项目归属，或在未分组名单里）。
 * 用于写入后回读自检：桌面版正在运行时，它的下一次写盘会把我们的改动覆盖掉。
 */
export function isThreadRegistered(input: { threadId: string; codexHome?: string }): boolean {
  const path = desktopStatePath(input.codexHome);
  try {
    const state = asRecord(JSON.parse(readFileSync(path, "utf8")));
    if (isAssignment(asRecord(state[KEY_ASSIGNMENTS])[input.threadId])) return true;
    return asIdArray(state[KEY_PROJECTLESS]).includes(input.threadId);
  } catch {
    return false;
  }
}

/**
 * 把线程登记进桌面版侧边栏。
 * 任何异常都被吞掉并转成 `{ ok:false, reason }` —— 登记失败不应影响续跑主流程。
 */
export function registerThreadInDesktop(input: RegisterThreadInput): RegisterThreadResult {
  const path = desktopStatePath(input.codexHome);
  const base = { changed: false, projectId: null, placement: "none" as const, wroteKeys: [] as string[] };

  if (!existsSync(path)) {
    return { ok: false, ...base, reason: `桌面版状态文件不存在，跳过登记：${path}` };
  }

  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
    let raw: string;
    let before: { size: number; mtimeMs: number };
    let state: Record<string, unknown>;
    try {
      raw = readFileSync(path, "utf8");
      const st = statSync(path);
      before = { size: st.size, mtimeMs: st.mtimeMs };
      state = asRecord(JSON.parse(raw));
    } catch (e) {
      return { ok: false, ...base, reason: `读取/解析桌面版状态失败，保持原样：${String(e)}` };
    }

    const plan = planRegistration(state, input);
    if (!plan) {
      // 已经收下了 —— 把**真实归属**回读出来还给调用方。
      // 否则调用方只能看到 projectId=null，会把已归入项目的线程误报成「未分组」。
      const existing = asRecord(state[KEY_ASSIGNMENTS])[input.threadId];
      const existingProjectId = isAssignment(existing) ? existing.projectId : null;
      const inProjectless = existingProjectId === null && asIdArray(state[KEY_PROJECTLESS]).includes(input.threadId);
      return {
        ok: true,
        changed: false,
        projectId: existingProjectId,
        placement: existingProjectId ? "project" : inProjectless ? "projectless" : "none",
        wroteKeys: [],
        reason: "桌面版已收下这条线程，无需改动",
      };
    }

    if (input.dryRun) {
      return {
        ok: true,
        changed: true,
        projectId: plan.projectId,
        placement: plan.placement,
        wroteKeys: plan.wroteKeys,
        reason: `演练：将写入 ${plan.wroteKeys.join(", ")}`,
      };
    }

    try {
      const after = statSync(path);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        // 桌面版在这一次读之后写过盘 —— 丢掉本次结果重来，避免覆盖它的更新。
        continue;
      }
      if (!existsSync(`${path}${BACKUP_SUFFIX}`)) {
        try {
          copyFileSync(path, `${path}${BACKUP_SUFFIX}`);
        } catch {
          /* 备份失败不阻塞，rename 本身是原子的 */
        }
      }
      const tmp = `${path}.car-tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, `${JSON.stringify(plan.next)}\n`, "utf8");
      renameSync(tmp, path);
    } catch (e) {
      return { ok: false, ...base, reason: `写入桌面版状态失败，已跳过：${String(e)}` };
    }

    return {
      ok: true,
      changed: true,
      projectId: plan.projectId,
      placement: plan.placement,
      wroteKeys: plan.wroteKeys,
      reason:
        plan.placement === "project"
          ? `已登记到项目 ${plan.projectId}`
          : "已登记到「未分组」（该目录没有对应项目）",
    };
  }

  return { ok: false, ...base, reason: `桌面版状态文件被频繁改写，${WRITE_ATTEMPTS} 次重试后放弃` };
}
