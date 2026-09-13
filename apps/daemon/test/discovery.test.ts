/**
 * 会话自动发现验收。
 *
 * 这是「撞 5h 限额后我不用醒来」的最后一块拼图：CAR 原本是任务队列，
 * 桌面版哪条会话撞了限额它一无所知，用户必须醒着手动建任务。
 *
 * 这里锁住的核心是**误捡**的边界 —— 自动建任务会自动跑 turn（消耗额度），
 * 所以宁可漏捡也不能捡错：只有「最后一个 turn 确实因额度失败」的线程才该被接管。
 *
 * 用真实 SqliteRepository（内存库），只把 app-server 用替身顶掉，
 * 因此 createTask / listTasks / forceStatus 走的是真实实现。
 *
 * 运行：tsx --test apps/daemon/test/discovery.test.ts
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRepository } from "@car/persistence";
import { createLogger } from "@car/logger";
import type { AppServerClient } from "@car/app-server-client";
import { DEFAULT_DISCOVERY, findInterruptedThreads, runDiscovery } from "../src/discovery.js";

const createdDirs: string[] = [];
after(() => {
  for (const d of createdDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "car-disc-"));
  createdDirs.push(dir);
  return dir;
}

const QUOTA_TURNS = [
  { id: "t1", status: "failed", error: { codexErrorInfo: "usageLimitExceeded", message: "usage limit reached" } },
];
const DONE_TURNS = [{ id: "t1", status: "completed", error: null }];

type ThreadRow = Record<string, unknown>;

/** 只应答 thread/list 与 thread/read 的 app-server 替身 */
function makeClient(rows: ThreadRow[], turnsByThread: Record<string, unknown[]>) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    isHealthy: () => true,
    async request(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params: params ?? {} });
      if (method === "thread/list") return { data: rows };
      if (method === "thread/read") return { thread: { turns: turnsByThread[String(params?.threadId)] ?? [] } };
      throw new Error("unexpected rpc in discovery test: " + method);
    },
  };
}

function threadRow(over: { id?: string; cwd?: string; updatedAt?: number; statusType?: string; name?: string } = {}): ThreadRow {
  return {
    id: over.id ?? "thread-a",
    cwd: over.cwd ?? makeProject(),
    updatedAt: over.updatedAt ?? Date.now(),
    status: { type: over.statusType ?? "idle" },
    name: over.name ?? "demo session",
  };
}

function setup() {
  const repo = new SqliteRepository(":memory:");
  repo.migrate();
  return repo;
}

function makeDeps(
  repo: SqliteRepository,
  rows: ThreadRow[],
  turns: Record<string, unknown[]>,
  config: Record<string, unknown> = {},
) {
  const client = makeClient(rows, turns);
  return {
    client: client as unknown as AppServerClient,
    rawClient: client,
    repo,
    logger: createLogger({ level: "error" }),
    config,
  };
}

function seedTask(repo: SqliteRepository, threadId: string, title = "seeded"): string {
  const t = repo.createTask({
    title,
    projectPath: makeProject(),
    originalGoal: "seed",
    mode: "resume_thread",
    threadId,
  });
  return t.id;
}

function adopted(repo: SqliteRepository) {
  return repo.listTasks().filter((t) => t.title.startsWith("Auto-resume:"));
}

/* ------------------------------- 用例 ------------------------------- */

test("接管：最后一个 turn 死于额度限制的线程会被自动建任务", async () => {
  const repo = setup();
  const cwd = makeProject();
  const d = makeDeps(repo, [threadRow({ id: "thread-a", cwd, name: "bgfc session" })], { "thread-a": QUOTA_TURNS });

  const out = await runDiscovery(d);

  assert.equal(out.created.length, 1);
  const tasks = repo.listTasks();
  assert.equal(tasks.length, 1);
  const t = tasks[0]!;
  assert.equal(t.mode, "resume_thread");
  assert.equal(t.threadId, "thread-a");
  assert.equal(t.projectPath, cwd);
  assert.equal(t.status, "READY");
  assert.equal(t.priority, DEFAULT_DISCOVERY.priority);
  assert.match(t.title, /bgfc session/);

  // 落了可追溯事件，方便事后解释「这条任务是谁建的」
  const ev = repo.db.prepare("SELECT COUNT(*) AS c FROM task_events WHERE method = ?").get("discovery/adopted") as { c: number };
  assert.equal(ev.c, 1);
});

test("不接管：最后一个 turn 正常完成的线程", async () => {
  const repo = setup();
  const d = makeDeps(repo, [threadRow({ id: "thread-a" })], { "thread-a": DONE_TURNS });

  const out = await runDiscovery(d);

  assert.equal(out.created.length, 0);
  assert.equal(repo.listTasks().length, 0);
  assert.equal(out.skipped[0]?.reason, "last turn was not quota-limited");
});

test("不接管：线程此刻在别处 active（绝不抢正在跑的会话）", async () => {
  const repo = setup();
  const d = makeDeps(repo, [threadRow({ id: "thread-a", statusType: "active" })], { "thread-a": QUOTA_TURNS });

  const out = await runDiscovery(d);

  assert.equal(out.created.length, 0);
  assert.equal(out.skipped[0]?.reason, "thread is active elsewhere");
  // 连 thread/read 都不该发出去
  assert.equal(d.rawClient.calls.filter((c) => c.method === "thread/read").length, 0);
});

test("不接管：已被活跃 CAR 任务占用的线程", async () => {
  const repo = setup();
  seedTask(repo, "thread-a");
  const d = makeDeps(repo, [threadRow({ id: "thread-a" })], { "thread-a": QUOTA_TURNS });

  const out = await runDiscovery(d);

  assert.equal(out.created.length, 0);
  assert.equal(out.skipped[0]?.reason, "already owned by an active task");
});

test("不接管：曾被取消过的线程永久跳过（否则每次扫描都会把用户刚取消的任务建回来）", async () => {
  const repo = setup();
  const id = seedTask(repo, "thread-a");
  repo.forceStatus(id, "CANCELLED");
  const d = makeDeps(repo, [threadRow({ id: "thread-a" })], { "thread-a": QUOTA_TURNS });

  const out = await runDiscovery(d);

  assert.equal(out.created.length, 0);
  assert.equal(out.skipped[0]?.reason, "marked cancelled or finally failed by the user");
});

test("不接管：fork 之后被血缘认领的父线程", async () => {
  const repo = setup();
  const id = seedTask(repo, "child-x");
  repo.patch(id, { forkedFromThreadId: "thread-a" });
  const d = makeDeps(repo, [threadRow({ id: "thread-a" })], { "thread-a": QUOTA_TURNS });

  const out = await runDiscovery(d);

  assert.equal(out.created.length, 0);
  assert.equal(out.skipped[0]?.reason, "already owned by an active task");
});

test("不接管：项目目录已不存在", async () => {
  const repo = setup();
  const gone = join(tmpdir(), "car-disc-missing-" + Date.now());
  const d = makeDeps(repo, [threadRow({ id: "thread-a", cwd: gone })], { "thread-a": QUOTA_TURNS });

  const out = await runDiscovery(d);

  assert.equal(out.created.length, 0);
  assert.equal(out.skipped[0]?.reason, "project directory no longer exists");
});

test("不接管：超过 lookback 的陈旧会话", async () => {
  const repo = setup();
  const stale = Date.now() - DEFAULT_DISCOVERY.lookbackMs - 60_000;
  const d = makeDeps(repo, [threadRow({ id: "thread-a", updatedAt: stale })], { "thread-a": QUOTA_TURNS });

  const out = await runDiscovery(d);

  assert.equal(out.created.length, 0);
  assert.equal(out.skipped[0]?.reason, "stale session");
});

// thread/list 实测返回的是**秒**级时间戳（0.153.4），CAR 内部是毫秒。
// 单位不一致会让每条线程都被判成陈旧 —— 功能静默失效且不报错，必须锁住。
test("时间戳单位：秒级 updatedAt 的近期线程不会被误判为陈旧", async () => {
  const repo = setup();
  const nowSec = Math.floor(Date.now() / 1000);
  const d = makeDeps(repo, [threadRow({ id: "thread-a", updatedAt: nowSec })], { "thread-a": QUOTA_TURNS });

  const out = await runDiscovery(d);

  assert.equal(out.created.length, 1);
  assert.equal(out.skipped.length, 0);
});

test("时间戳单位：秒级 updatedAt 的陈旧线程仍然会被拦下", async () => {
  const repo = setup();
  const staleSec = Math.floor((Date.now() - DEFAULT_DISCOVERY.lookbackMs - 60_000) / 1000);
  const d = makeDeps(repo, [threadRow({ id: "thread-a", updatedAt: staleSec })], { "thread-a": QUOTA_TURNS });

  const out = await runDiscovery(d);

  assert.equal(out.created.length, 0);
  assert.equal(out.skipped[0]?.reason, "stale session");
});

test("封顶：单次扫描建的任务数不超过 maxPerScan", async () => {
  const repo = setup();
  const rows = [threadRow({ id: "t-a" }), threadRow({ id: "t-b" }), threadRow({ id: "t-c" })];
  const d = makeDeps(repo, rows, { "t-a": QUOTA_TURNS, "t-b": QUOTA_TURNS, "t-c": QUOTA_TURNS }, { maxPerScan: 2 });

  const out = await runDiscovery(d);

  assert.equal(out.candidates.length, 3);
  assert.equal(out.created.length, 2);
  assert.equal(adopted(repo).length, 2);
});

test("开关：enabled=false 时连 app-server 都不碰", async () => {
  const repo = setup();
  const d = makeDeps(repo, [threadRow({ id: "thread-a" })], { "thread-a": QUOTA_TURNS }, { enabled: false });

  const out = await runDiscovery(d);

  assert.equal(out.created.length, 0);
  assert.equal(d.rawClient.calls.length, 0);
});

test("纯扫描：findInterruptedThreads 只判定不写库", async () => {
  const repo = setup();
  const d = makeDeps(repo, [threadRow({ id: "thread-a" })], { "thread-a": QUOTA_TURNS });

  const out = await findInterruptedThreads(d);

  assert.equal(out.candidates.length, 1);
  assert.equal(out.candidates[0]?.threadId, "thread-a");
  assert.equal(out.candidates[0]?.lastTurnId, "t1");
  assert.equal(out.candidates[0]?.errorInfo, "usageLimitExceeded");
  assert.equal(repo.listTasks().length, 0);
});
