/**
 * 「把 CAR 造的线程登记进桌面版侧边栏」的回归。
 *
 * 背景（实测）：CAR 的 `thread/fork` / `thread/start` 产物在 app-server 侧一切正常
 * （`thread/list` 默认参数就能返回），但桌面版侧边栏不按它渲染 —— 侧边栏认的是
 * `.codex-global-state.json` 里的 `thread-project-assignments` /
 * `sidebar-project-thread-orders` / `projectless-thread-ids`，而桌面版只在
 * 自己建线程或用户改动项目根路径时才做对账。于是外部进程造的线程永久不可见。
 *
 * 运行：vitest run
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  matchProjectByCwd,
  normalizePath,
  planRegistration,
  registerThreadInDesktop,
} from "../src/index.js";

const PROJECT_ID = "c74b6f92-946e-4b96-8d82-61049cd26e48";
const PARENT = "01a09bc3-dff2-78a3-9b97-f12797f07007";
const CHILD = "01a09eab-2b2a-7331-9abf-14ba3363c63d";

/** 最贴近真机的一份最小状态：一个本地项目 + 父线程已归属该项目。 */
function fixture(): Record<string, unknown> {
  return {
    "local-projects": {
      [PROJECT_ID]: {
        id: PROJECT_ID,
        name: "Boy/Girl-friend_Copilot",
        rootPaths: ["D:\\BoyGirl-friend_Copilot"],
        createdAt: 1787914315810,
        updatedAt: 1787914315810,
      },
    },
    "thread-project-assignments": {
      [PARENT]: { projectKind: "local", projectId: PROJECT_ID },
    },
    "sidebar-project-thread-orders": {
      [PROJECT_ID]: { threadIds: [PARENT, "older-thread"] },
    },
    "projectless-thread-ids": ["some-automation-thread"],
    selected_project: "keep-me",
    "project-order": [PROJECT_ID],
  };
}

describe("normalizePath", () => {
  it("strips the extended-length prefix and the trailing separator", () => {
    expect(normalizePath("\\\\?\\D:\\BoyGirl-friend_Copilot")).toBe("d:/boygirl-friend_copilot");
    expect(normalizePath("D:\\BoyGirl-friend_Copilot\\")).toBe("d:/boygirl-friend_copilot");
    expect(normalizePath(null)).toBe("");
  });
});

describe("matchProjectByCwd", () => {
  it("finds the project whose root matches the thread cwd", () => {
    expect(matchProjectByCwd(fixture(), "\\\\?\\D:\\BoyGirl-friend_Copilot")).toBe(PROJECT_ID);
    expect(matchProjectByCwd(fixture(), "D:\\elsewhere")).toBe(null);
  });
});

describe("planRegistration", () => {
  it("inherits the parent's assignment and prepends to the project order", () => {
    const plan = planRegistration(fixture(), { threadId: CHILD, parentThreadId: PARENT, cwd: "D:\\BoyGirl-friend_Copilot" });
    expect(plan).not.toBeNull();
    expect(plan?.placement).toBe("project");
    expect(plan?.projectId).toBe(PROJECT_ID);
    const assignments = plan?.next["thread-project-assignments"] as Record<string, unknown>;
    expect(assignments[CHILD]).toEqual({ projectKind: "local", projectId: PROJECT_ID });
    const orders = plan?.next["sidebar-project-thread-orders"] as Record<string, { threadIds: string[] }>;
    expect(orders[PROJECT_ID]!.threadIds[0]).toBe(CHILD);
    expect(orders[PROJECT_ID]!.threadIds).toContain(PARENT);
  });

  it("falls back to cwd matching when there is no parent to inherit from", () => {
    const plan = planRegistration(fixture(), { threadId: "brand-new", cwd: "D:\\BoyGirl-friend_Copilot" });
    expect(plan?.projectId).toBe(PROJECT_ID);
  });

  it("parks an orphan in the ungrouped bucket when nothing matches", () => {
    const plan = planRegistration(fixture(), { threadId: "orphan", cwd: "D:\\no-such-project" });
    expect(plan?.placement).toBe("projectless");
    expect(plan?.projectId).toBe(null);
    expect(plan?.next["projectless-thread-ids"]).toEqual(["orphan", "some-automation-thread"]);
  });

  it("is idempotent — a second pass reports no change", () => {
    const input = { threadId: CHILD, parentThreadId: PARENT, cwd: "D:\\BoyGirl-friend_Copilot" };
    const first = planRegistration(fixture(), input);
    expect(first).not.toBeNull();
    expect(planRegistration(first!.next, input)).toBe(null);
  });

  it("leaves an already-assigned thread completely alone", () => {
    // 父线程已经在项目组里了：再登记一次不得把它也塞进未分组名单
    expect(planRegistration(fixture(), { threadId: PARENT, cwd: "D:\\BoyGirl-friend_Copilot" })).toBe(null);
  });

  it("leaves a thread the desktop already parked in the ungrouped list alone", () => {
    expect(planRegistration(fixture(), { threadId: "some-automation-thread", cwd: "D:\\nope" })).toBe(null);
    expect(planRegistration(fixture(), { threadId: "some-automation-thread", cwd: "D:\\BoyGirl-friend_Copilot" })).toBe(null);
  });

  it("never drops unrelated keys", () => {
    const plan = planRegistration(fixture(), { threadId: CHILD, parentThreadId: PARENT });
    expect(plan?.next["selected_project"]).toBe("keep-me");
    expect(plan?.next["project-order"]).toEqual([PROJECT_ID]);
  });
});

describe("registerThreadInDesktop", () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "car-desktop-registry-"));
    statePath = join(dir, ".codex-global-state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (state: unknown) => writeFileSync(statePath, JSON.stringify(state), "utf8");
  const read = () => JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;

  it("registers a forked child into the desktop's project view", () => {
    write(fixture());
    const res = registerThreadInDesktop({ threadId: CHILD, parentThreadId: PARENT, cwd: "D:\\BoyGirl-friend_Copilot", codexHome: dir });
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.projectId).toBe(PROJECT_ID);
    const onDisk = read();
    expect((onDisk["thread-project-assignments"] as Record<string, unknown>)[CHILD]).toBeTruthy();
    expect((onDisk["sidebar-project-thread-orders"] as Record<string, Record<string, string[]>>)[PROJECT_ID]!.threadIds).toContain(CHILD);
  });

  it("keeps a one-shot backup of the pre-change file", () => {
    write(fixture());
    registerThreadInDesktop({ threadId: CHILD, parentThreadId: PARENT, codexHome: dir });
    const backup = JSON.parse(readFileSync(`${statePath}.car-backup`, "utf8")) as Record<string, unknown>;
    expect((backup["thread-project-assignments"] as Record<string, unknown>)[CHILD]).toBeUndefined();
    // 第二次运行不得覆盖备份
    registerThreadInDesktop({ threadId: "another", cwd: "D:\\BoyGirl-friend_Copilot", codexHome: dir });
    const backup2 = JSON.parse(readFileSync(`${statePath}.car-backup`, "utf8")) as Record<string, unknown>;
    expect((backup2["thread-project-assignments"] as Record<string, unknown>)["another"]).toBeUndefined();
  });

  it("dryRun reports the plan without touching the file", () => {
    write(fixture());
    const before = readFileSync(statePath, "utf8");
    const res = registerThreadInDesktop({ threadId: CHILD, parentThreadId: PARENT, codexHome: dir, dryRun: true });
    expect(res.changed).toBe(true);
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("refuses to touch an unparseable state file", () => {
    writeFileSync(statePath, "{ not json", "utf8");
    const res = registerThreadInDesktop({ threadId: CHILD, codexHome: dir });
    expect(res.ok).toBe(false);
    expect(readFileSync(statePath, "utf8")).toBe("{ not json");
  });

  it("degrades quietly when the desktop has never run", () => {
    const res = registerThreadInDesktop({ threadId: CHILD, codexHome: join(dir, "nope") });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("不存在");
  });
});
