/**
 * 进程重启后的任务恢复 —— 「撞 5h 后不用醒来」在**自己这一侧**的最后一块拼图。
 *
 * 老行为：凡是 daemon 重启时还挂在 RUNNING 的任务，一律 WAITING_USER。
 * 于是哪怕额度早就恢复了、哪怕这次中断跟额度毫无关系，用户也必须醒着手动点一次续跑。
 * 本轮 daemon 重启把 01a09bc3 那次续跑掐断，就是这么被停下的。
 *
 * 新行为：读线程的 turn 历史，把两种命运分开 ——
 *   · 最后一个 turn 已经 `completed`：崩溃发生在「跑完」和「落库」之间，活儿可能已经干完
 *     （agent 主动停下要人决策也落在这里）→ 保守，等人确认。
 *   · 最后一个 turn 被掐断（`interrupted` / `failed` / `inProgress`）：工作明确没做完
 *     → 直接排队续跑。
 *
 * 判定逻辑抽在纯函数 `decideRecovery()` 里，本模块只负责读线程 + 落库。
 *
 * 顺带自愈一类历史遗留：老代码把「崩溃留下的 RUNNING」错判成 WAITING_USER 并写下
 * `RECOVERY_NEEDS_CONFIRM` —— 那批任务在旧逻辑下永远不会再动。本轮用同一套判定重过一遍。
 * 这个标记只有恢复扫描会写（人不会），因此「带着它的 WAITING_USER」必然是机器停的，
 * 自动重新评估不会覆盖用户的任何决定。
 */

import type { AppServerClient } from "@car/app-server-client";
import type { Logger } from "@car/logger";
import type { ManagedTask, SqliteRepository } from "@car/persistence";
import { RECOVERY_NEEDS_CONFIRM, decideRecovery } from "@car/task-engine";

export interface RecoveryDeps {
  client: Pick<AppServerClient, "request">;
  repo: SqliteRepository;
  logger: Logger;
}

export interface RecoveryOutcome {
  /** 本轮重新评估过的任务数 */
  examined: number;
  /** 判定「活儿没干完」→ 排队续跑 */
  resumed: string[];
  /** 判定「可能需要人」→ 保持 WAITING_USER */
  parked: string[];
  /** 命中额度特征 → WAITING_QUOTA，等恢复推送 */
  quotaDeferred: string[];
  /** 其中属于「历史遗留、本轮自愈捞回来」的任务 */
  reclaimed: string[];
}

interface TurnRow {
  id?: string;
  status?: string;
}

/**
 * 读一条线程的 turn 历史。
 *
 * 任何失败都返回 `readable: false` —— 判定层据此 fail closed，绝不因为读不到就放行。
 */
async function readTurns(
  deps: RecoveryDeps,
  threadId: string | null,
): Promise<{ readable: boolean; turns: TurnRow[] | undefined }> {
  if (!threadId) return { readable: false, turns: undefined };
  try {
    const resp = await deps.client.request<{ thread?: { turns?: TurnRow[] } }>("thread/read", {
      threadId,
      includeTurns: true,
    });
    if (!resp?.thread) return { readable: false, turns: undefined };
    return { readable: true, turns: resp.thread.turns };
  } catch (e) {
    deps.logger.debug("recovery: thread/read failed", { threadId, err: String(e) });
    return { readable: false, turns: undefined };
  }
}

export async function recoverInterruptedTasks(
  deps: RecoveryDeps,
  abnormal: ManagedTask[],
): Promise<RecoveryOutcome> {
  const out: RecoveryOutcome = { examined: 0, resumed: [], parked: [], quotaDeferred: [], reclaimed: [] };

  // ① 本次启动抓到的异常任务（status 已被 scanAbnormalRunning 置成 RECOVERING）
  // ② 历史遗留：带 RECOVERY_NEEDS_CONFIRM 标记的 WAITING_USER（老逻辑留下的死结）
  const legacy = deps.repo
    .listTasks()
    .filter((t) => t.status === "WAITING_USER" && t.lastError === RECOVERY_NEEDS_CONFIRM);
  const legacyIds = new Set(legacy.map((t) => t.id));

  for (const task of [...abnormal, ...legacy]) {
    out.examined++;
    // 一律以库里的当前值为准，不信调用方传进来的快照 ——
    // abnormal 是 scanAbnormalRunning() 那一刻的快照，之后字段可能已被改过
    // （比如恢复扫描自己刚打完的额度标记），拿旧快照判断会静默判错。
    const fresh = deps.repo.getTask(task.id) ?? task;
    const threadId = fresh.threadId ?? fresh.lastQuotaInterruptedThreadId ?? null;
    const quotaHit = deps.repo.lastRunQuotaExhausted(task.id) || fresh.lastQuotaInterruptedAt != null;
    const { readable, turns } = await readTurns(deps, threadId);
    const decision = decideRecovery({ quotaHit, threadReadable: readable, turns });

    const isLegacy = legacyIds.has(task.id);
    if (decision.action === "READY") {
      deps.repo.forceStatus(task.id, "READY");
      deps.repo.patch(task.id, { nextRunAt: Date.now(), lastError: null });
      deps.repo.appendEvent(task.id, isLegacy ? "recover/reclaimed" : "recover/resumed-cut-off", {
        threadId,
        lastTurnStatus: decision.lastTurnStatus,
        why: decision.why,
      });
      out.resumed.push(task.id);
      if (isLegacy) out.reclaimed.push(task.id);
      deps.logger.warn("recovery: run was cut off mid-turn; queued to resume", {
        taskId: task.id,
        threadId,
        lastTurnStatus: decision.lastTurnStatus,
        reclaimed: isLegacy,
      });
      continue;
    }

    deps.repo.forceStatus(task.id, decision.action);
    deps.repo.patch(task.id, { lastError: decision.lastError });
    deps.repo.appendEvent(task.id, "recover/parked", {
      threadId,
      lastTurnStatus: decision.lastTurnStatus,
      action: decision.action,
      why: decision.why,
    });
    if (decision.action === "WAITING_QUOTA") out.quotaDeferred.push(task.id);
    else out.parked.push(task.id);
    deps.logger.info("recovery: parked for the user", {
      taskId: task.id,
      threadId,
      action: decision.action,
      lastTurnStatus: decision.lastTurnStatus,
    });
  }

  return out;
}
