/**
 * codex-resolver 的暂存完整性回归。
 *
 * 背景（真实事故）：暂存目录里漏了 `codex-code-mode-host.exe`，而解析器看到
 * 「暂存副本能跑」就早返回，缺的文件永远补不上。后果是续跑回来的任务里 agent
 * 执行任何命令都失败，只能返回 needs_user 空转。这里把清单本身锁进断言。
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { missingStagedSiblings, requiredStagedSiblings, stageSiblingsFrom } from "../src/index.js";

const created: string[] = [];
function tempDir(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `car-resolver-${tag}-`));
  created.push(d);
  return d;
}
function seed(dir: string, entries: string[]): void {
  for (const e of entries) mkdirSync(join(dir, e), { recursive: true });
}

afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

describe("staged codex siblings", () => {
  it("an empty staging dir reports every required entry as missing", () => {
    const dir = tempDir("empty");
    expect(missingStagedSiblings(dir).sort()).toEqual(requiredStagedSiblings().sort());
  });

  it("the command-execution host is part of the required set", () => {
    // 本次事故的回归闸门：清单一旦再漏掉它，agent 就跑不了任何命令。
    const required = requiredStagedSiblings();
    if (process.platform === "win32") {
      expect(required).toContain("codex-code-mode-host.exe");
      expect(required).toContain("codex-windows-sandbox-setup.exe");
    }
  });

  it("staging copies what is missing and skips what is already there", () => {
    const src = tempDir("src");
    const dest = tempDir("dest");
    const all = requiredStagedSiblings();
    // 来源里故意不放 "codex" —— 验证「来源没有就跳过，不算补齐」
    seed(src, all.filter((e) => e !== "codex"));
    seed(dest, ["plugins"]); // 目标已有，应跳过

    const copied = stageSiblingsFrom(src, dest);

    expect(copied).not.toContain("plugins");
    expect(copied).not.toContain("codex");
    expect(copied).toContain("codex-command-runner.exe");
    expect(missingStagedSiblings(dest)).toEqual(["codex"]);
  });

  it("staging from a complete source leaves nothing missing", () => {
    const src = tempDir("src-full");
    const dest = tempDir("dest-full");
    seed(src, requiredStagedSiblings());

    const copied = stageSiblingsFrom(src, dest);

    expect(copied.sort()).toEqual(requiredStagedSiblings().sort());
    expect(missingStagedSiblings(dest)).toEqual([]);
  });

  it("a complete staging dir is never reported as needing repair", () => {
    const dir = tempDir("complete");
    seed(dir, requiredStagedSiblings());
    expect(missingStagedSiblings(dir)).toEqual([]);
  });
});
