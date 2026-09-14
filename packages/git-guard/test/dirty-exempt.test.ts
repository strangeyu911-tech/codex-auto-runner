/**
 * 「哪些任务容忍脏工作区」的策略回归。
 *
 * 起因：桌面端那条 resume 任务在 `D:\BoyGirl-friend_Copilot` 里被
 * 「工作区不干净；需要显式授权」永久停在 WAITING_USER —— 它其实是个只读任务
 * （sandbox=readOnly，指令明说不要修改任何文件），却被这条闸门拦了。
 * 更严重的是自动接管建出来的任务（resume_thread + workspaceWrite + direct）在任何
 * 活跃仓库里都会被同样拦死，而活跃仓库恰恰最容易被额度打断、最需要自动接管。
 *
 * 运行：vitest run
 */
import { describe, expect, it } from "vitest";
import { toleratesDirtyWorktree } from "../src/index.js";

/** 最严格的默认形态：新线程 + 可写沙箱 + 直接在主工作区跑 */
const STRICT = { mode: "new_thread", sandboxMode: "workspaceWrite", workspaceMode: "direct" };

describe("toleratesDirtyWorktree", () => {
  it("lets a resumed thread back into its own workspace", () => {
    expect(toleratesDirtyWorktree({ ...STRICT, mode: "resume_thread" })).toBe(true);
    expect(toleratesDirtyWorktree({ ...STRICT, mode: "imported_thread" })).toBe(true);
  });

  it("lets a read-only task through — the sandbox already forbids writing", () => {
    expect(toleratesDirtyWorktree({ ...STRICT, sandboxMode: "readOnly" })).toBe(true);
  });

  it("keeps the guard for a brand-new write task", () => {
    expect(toleratesDirtyWorktree(STRICT)).toBe(false);
  });

  it("never asks a worktree run to keep the main tree clean", () => {
    expect(
      toleratesDirtyWorktree({ mode: "new_thread", sandboxMode: "workspaceWrite", workspaceMode: "worktree" }),
    ).toBe(true);
  });
});
