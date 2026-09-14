/**
 * Codex Auto Runner — 后台守护进程入口。
 *
 * 闭环：
 *   单实例锁 → 解析 codex → 启动 app-server → 打开/迁移 DB
 *   → 恢复扫描（RECOVERING）→ 恢复判定：被进程死亡掐断的任务直接续跑，
 *     只有「turn 其实已跑完」的才交给人确认
 *   → QuotaWatcher 监测额度
 *   → Scheduler 周期 tick + 额度恢复后立即 tick
 *   → 会话自动发现：撞限额的桌面版会话自动建任务接管（可 CAR_DISCOVERY=0 关闭）
 *   → 额度可用且无 RUNNING 任务 → claim 最高优先级 → runOneTurn
 *   → 额度耗尽 -> WAITING_QUOTA + 检查点 → 等恢复 → 续跑
 *
 * 运行：
 *   pnpm --filter @car/daemon start
 *   CAR_LOG_LEVEL=debug          细查
 *   CAR_DAEMON_TICK_MS=30000     scheduler 周期（默认 30s）
 *   CAR_DATA_DIR=...             覆盖数据目录
 *   CAR_DISCOVERY=0              关闭会话自动发现
 *   CAR_DISCOVERY_INTERVAL_MS   自动发现扫描间隔（默认 60s）
 */

import { resolveCodex } from "@car/codex-resolver";
import { AppServerClient } from "@car/app-server-client";
import { createLogger } from "@car/logger";
import { DEFAULT_CONFIG, type RunnerConfig } from "@car/shared-types";
import { SqliteRepository, defaultDataDir } from "@car/persistence";
import { TaskEngine } from "@car/task-engine";
import { InstanceLock } from "./instance-lock.js";
import { QuotaWatcher } from "./quota-watch.js";
import { recoverInterruptedTasks } from "./recovery.js";
import { Scheduler } from "./scheduler.js";
import { startHttpApi } from "./http-api.js";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

function overrideDataDir(): string | undefined {
  if (process.env.CAR_DATA_DIR) return process.env.CAR_DATA_DIR;
  return undefined;
}

async function main(): Promise<void> {
  const log = createLogger({ level: (process.env.CAR_LOG_LEVEL as "info" | "debug" | "warn" | "error") ?? "info" });
  const cfg: RunnerConfig = structuredClone(DEFAULT_CONFIG);
  const dataDir = overrideDataDir() ?? defaultDataDir();
  mkdirSync(dataDir, { recursive: true });

  // 单实例
  const lock = new InstanceLock(dataDir);
  const acq = lock.acquire();
  if (!acq.ok) {
    log.error("daemon already running, exiting", { reason: acq.reason });
    process.exit(2);
  }
  log.info("daemon starting", { pid: process.pid, dataDir, autoRun: cfg.app.autoRunEnabled });

  // 持久化
  const repo = new SqliteRepository(join(dataDir, "runner.db"));
  repo.migrate();

  // 恢复扫描：先无条件把「异常运行中」的任务收进 RECOVERING，避免调度器抢跑。
  // 真正的去留判定要等 app-server 起来 —— 只有读到线程的 turn 历史，才能区分
  // 「活儿已经干完」和「活儿被掐断」，见下方 recoverInterruptedTasks()。
  const abnormal = repo.scanAbnormalRunning();
  if (abnormal.length) log.warn("recovery: marked abnormal tasks RECOVERING", { count: abnormal.length });

  // 自动运行开关（持久化在 settings.json）
  const settingsFile = join(dataDir, "settings.json");
  let autoRun = cfg.app.autoRunEnabled;
  if (existsSync(settingsFile)) {
    try { autoRun = !!JSON.parse(readFileSync(settingsFile, "utf8")).autoRunEnabled; } catch { /* ignore */ }
  }
  const setAutoRun = (v: boolean) => {
    autoRun = v;
    writeFileSync(settingsFile, JSON.stringify({ autoRunEnabled: v }, null, 2));
  };

  // codex
  const codex = await resolveCodex(log);
  log.info("codex ready", { source: codex.source, version: codex.version, staged: codex.staged });

  // App Server 客户端
  const client = new AppServerClient({ codexPath: codex.path, logger: log, requestTimeoutMs: 60_000 });
  client.on("stderr", (line: string) => log.debug("app-server stderr", { line }));
  await client.start();

  // 恢复判定：把「被进程死亡掐断」的任务直接放回队列，而不是一律等人确认。
  // 额度语义（WAITING_QUOTA + 重置时间）优先于自动续跑，见 decideRecovery()。
  const recovery = await recoverInterruptedTasks({ client, repo, logger: log }, abnormal);
  if (recovery.examined) {
    log.info("recovery complete", {
      examined: recovery.examined,
      resumed: recovery.resumed.length,
      reclaimed: recovery.reclaimed.length,
      parked: recovery.parked.length,
      quotaDeferred: recovery.quotaDeferred.length,
    });
  }

  // 任务引擎
  const engine = new TaskEngine({ client, repo, logger: log, tasksDir: join(dataDir, "tasks") });

  // 额度快照共享给 scheduler
  let latestQuota: import("@car/quota-engine").QuotaSnapshot | null = null;
  let watcher: QuotaWatcher;

  // Scheduler
  const scheduler = new Scheduler({
    client,
    repo,
    engine,
    logger: log,
    isAutoRunEnabled: () => autoRun,
    getQuotaSnapshot: () => latestQuota,
    refreshQuotaSnapshot: () => watcher.refresh(),
    discovery: {
      // 会话自动发现：把「被额度打断、CAR 还不知道」的桌面版会话自动接进队列。
      // CAR_DISCOVERY=0 可整体关掉（默认开）。
      enabled: process.env.CAR_DISCOVERY !== "0",
      intervalMs: Number(process.env.CAR_DISCOVERY_INTERVAL_MS ?? 60_000),
    },
  });

  // QuotaWatcher
  const statusFile = join(dataDir, "status.json");
  const eventsFile = join(dataDir, "events.jsonl");
  watcher = new QuotaWatcher({
    client,
    config: cfg,
    logger: log,
    statusFile,
    onRecovered: async () => {
      log.warn("QUOTA RECOVERED -> scheduler.onQuotaRecovered", {});
      appendEvent(eventsFile, { type: "quota_recovered", at: Date.now() });
      try { await scheduler.onQuotaRecovered(); } catch (e) { log.error("onQuotaRecovered tick failed", { err: String(e) }); }
    },
  });
  watcher.on("snapshot", (snap) => {
    latestQuota = snap;
    repo.recordQuotaSnapshot(snap.status, snap.usedPercent, snap.nextEligibleAt, { buckets: snap.buckets.length, blocking: snap.blockingBuckets.length });
  });
  watcher.on("statusChange", (from, to) => appendEvent(eventsFile, { type: "quota_status_change", from, to, at: Date.now() }));

  // 启动
  await watcher.start();
  scheduler.start(Number(process.env.CAR_DAEMON_TICK_MS ?? 30_000));

  // 启动时立即尝试一次（如果有可运行任务且额度可用）
  void scheduler.tick().catch((e) => log.error("startup tick error", { err: String(e) }));

  // HTTP API（供前端调用）。端口默认 0=自动；可用 CAR_API_PORT 固定
  // webDir 惰性解析：`apps/web/dist` 常在 daemon 启动后才 build 出来，
  // 启动时解析一次会让之后 build 也不生效。命中后缓存，避免每次请求都 stat。
  let webDirCache: string | undefined;
  const getWebDir = (): string | undefined => {
    if (!webDirCache) webDirCache = resolveWebDir();
    return webDirCache;
  };
  const httpPort = Number(process.env.CAR_API_PORT ?? 0);
  const http = await startHttpApi({ repo, client, dataDir, logger: log, getQuotaSnapshot: () => latestQuota, getAutoRun: () => autoRun, setAutoRun, getWebDir }, httpPort);
  writeFileSync(join(dataDir, "api.json"), JSON.stringify({ baseUrl: http.baseUrl, port: http.port, tokenFile: "car-api.token" }, null, 2));
  log.info("http api ready", { baseUrl: http.baseUrl, webDir: getWebDir() ?? "(none yet, dev mode or dist not built)" });

  // 优雅退出
  const shutdown = async (sig: string) => {
    log.info("shutdown signal", { sig });
    scheduler.stop();
    watcher.stop();
    await client.close();
    repo.close();
    lock.release();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  log.info("daemon running; Ctrl+C to stop", { autoRun, tickMs: process.env.CAR_DAEMON_TICK_MS ?? 30000 });
}

function appendEvent(file: string, rec: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ ...rec }) + "\n");
  } catch { /* ignore */ }
}

/** 解析 apps/web/dist 目录（仓库内），用 import.meta.url 相对定位 */
function resolveWebDir(): string | undefined {
  const here = new URL(".", import.meta.url).pathname.replace(/^\//, "").replace(/\//g, "\\");
  // here = apps/daemon/src/
  const candidates = [
    join(here, "..", "..", "web", "dist"),
    join(here, "..", "..", "..", "apps", "web", "dist"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "index.html"))) return c;
  }
  return undefined;
}

main().catch((e) => {
  process.stderr.write("daemon fatal: " + (e?.stack ?? String(e)) + "\n");
  process.exit(1);
});
