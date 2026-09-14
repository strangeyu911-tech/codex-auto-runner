/**
 * Codex 可执行文件解析器。
 *
 * 背景：Codex 桌面版（MSIX）把 codex.exe 放在
 *   C:\Program Files\WindowsApps\OpenAI.Codex_*\app\resources\codex.exe
 * 该目录受 ACL 保护，直接调用会 "Access is denied"，且没有注册执行别名。
 * 解决：探测目标二进制后，将其连同 `codex` 等依赖目录整体拷贝到用户可写暂存区，
 *   后续统一从暂存区运行。也支持用户通过 CAR_CODEX_EXEC 显式指定。
 */

import { existsSync, copyFileSync, mkdirSync, cpSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import type { Logger } from "@car/logger";

export interface CodexResolveResult {
  path: string;
  version: string | null;
  source: "env" | "path" | "staged" | "windowsapps";
  staged: boolean;
}

const ENV_VAR = "CAR_CODEX_EXEC";

export function redactLocalPath(path: string): string {
  let out = path.replace(/\//g, "\\");
  out = replacePathPrefix(out, process.env.LOCALAPPDATA, "%LOCALAPPDATA%");
  out = replacePathPrefix(out, process.env.USERPROFILE ?? homedir(), "%USERPROFILE%");
  out = replacePathPrefix(out, process.env.ProgramFiles, "%ProgramFiles%");
  out = replacePathPrefix(out, process.env["ProgramFiles(x86)"], "%ProgramFiles(x86)%");
  return out;
}

function replacePathPrefix(path: string, prefix: string | undefined, label: string): string {
  if (!prefix) return path;
  const cleanPrefix = prefix.replace(/\//g, "\\").replace(/\\+$/, "");
  if (!cleanPrefix) return path;
  if (!path.toLowerCase().startsWith(cleanPrefix.toLowerCase())) return path;
  return label + path.slice(cleanPrefix.length);
}

/**
 * 用 PowerShell Get-AppxPackage 免提权探测 Codex 桌面版安装路径。
 * 直接 readdirSync("C:\Program Files\WindowsApps") 会被 ACL 拒绝（需提权）。
 */
function candidateWindowsAppsCodex(): string | null {
  const ps = `
    $ErrorActionPreference='SilentlyContinue';
    $p = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object -Property Version -Descending | Select-Object -First 1;
    if ($p) { Join-Path $p.InstallLocation 'app\\resources\\codex.exe' }
  `;
  try {
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 15_000,
    });
    if (r.status === 0 && r.stdout) {
      const path = r.stdout.trim();
      if (path && existsSync(path)) return path;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function tryVersion(p: string): string | null {
  try {
    const r = spawnSync(p, ["--version"], { windowsHide: true, encoding: "utf8", timeout: 10_000 });
    if (r.status === 0 && r.stdout) {
      const m = r.stdout.match(/[\d]+\.[\d]+\.[\d]+/);
      return m ? m[0] : r.stdout.trim();
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 默认暂存目录：%LOCALAPPDATA%\CodexAutoRunner\codex-portable\codex.exe */
export function defaultStagingDir(): string {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(local, "CodexAutoRunner", "codex-portable");
}

/**
 * codex.exe 在**自身同目录**下查找的配套条目。
 *
 * 这份清单必须跟 MSIX 的 `app\resources\` 对齐：少一个就会在运行期才炸，
 * 而且炸得很隐蔽 —— 实测漏掉 `codex-code-mode-host.exe` 时，codex.exe 本身
 * 跑得好好的，但 agent 执行任何命令都会报「本地命令执行宿主缺失」，
 * 于是续跑回来的任务只能空转着返回 needs_user。
 *
 * （`codex.exe` 自己不在这里，它由 resolveCodex 单独 copyFileSync 过去。）
 */
const STAGED_SIBLINGS = [
  "codex",
  "codex-command-runner.exe",
  "codex-code-mode-host.exe",
  "codex-windows-sandbox-setup.exe",
  "plugins",
  "cua_node",
] as const;

/** 当前平台上真正需要的暂存条目（非 Windows 上跳过 .exe）。 */
export function requiredStagedSiblings(): string[] {
  return STAGED_SIBLINGS.filter((e) => process.platform === "win32" || !e.endsWith(".exe"));
}

/** 暂存区里缺哪些必需条目；空数组表示完整。 */
export function missingStagedSiblings(dir: string = defaultStagingDir()): string[] {
  return requiredStagedSiblings().filter((e) => !existsSync(join(dir, e)));
}

/**
 * 把 srcDir 中「目标缺失但来源存在」的条目补进 dest，返回实际补齐的条目名。
 * 单个条目失败不影响其它（best effort）。
 */
export function stageSiblingsFrom(srcDir: string, dest = defaultStagingDir()): string[] {
  const done: string[] = [];
  for (const entry of requiredStagedSiblings()) {
    const from = join(srcDir, entry);
    const to = join(dest, entry);
    if (existsSync(to) || !existsSync(from)) continue;
    try {
      cpSync(from, to, { recursive: true });
      done.push(entry);
    } catch {
      /* ignore */
    }
  }
  return done;
}

/**
 * 候选来源目录，按可信度排序：
 *   1. MSIX 的 `app\resources\`（与暂存副本同一次安装，版本最对得上）
 *   2. 桌面版 native bin：%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\
 *      （桌面版把 code-mode-host / sandbox-setup 放这里，MSIX 里也有一份）
 */
export function candidateSiblingSources(): string[] {
  const out: string[] = [];
  const msix = candidateWindowsAppsCodex();
  if (msix) out.push(dirname(msix));
  const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const binRoot = join(local, "OpenAI", "Codex", "bin");
  if (existsSync(binRoot)) {
    try {
      for (const e of readdirSync(binRoot, { withFileTypes: true })) {
        if (e.isDirectory()) out.push(join(binRoot, e.name));
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * 补齐暂存区里缺的配套文件；返回仍然缺的条目（空数组 = 已完整）。
 *
 * 为什么需要单独一步：解析器第 2 步看到「暂存副本能跑」就直接返回了，
 * 于是**老暂存区里缺的文件永远补不上**。本机就是这种情况：很早之前暂存下来的
 * 副本少了 code-mode-host，之后每次续跑都只能空转。best effort，找不到来源
 * 只记 warn，不阻断 daemon 启动。
 */
export function repairStaging(log?: Logger, dest: string = defaultStagingDir()): string[] {
  const missing = missingStagedSiblings(dest);
  if (!missing.length) return [];
  log?.warn("staged codex missing runtime siblings, repairing", { missing });
  for (const src of candidateSiblingSources()) {
    const repaired = stageSiblingsFrom(src, dest);
    if (repaired.length) log?.info("staged codex repaired", { from: redactLocalPath(src), repaired });
    if (!missingStagedSiblings(dest).length) break;
  }
  const still = missingStagedSiblings(dest);
  if (still.length) log?.warn("staged codex still incomplete after repair", { missing: still });
  return still;
}

/**
 * 解析 codex 可执行路径。
 *
 * 优先级：
 *   1. env CAR_CODEX_EXEC（若可运行，直接用）
 *   2. 已有暂存副本（若可运行，直接用）
 *   3. PATH 中的 codex
 *   4. WindowsApps 内置 codex.exe —— 拷贝到暂存区后使用
 */
export async function resolveCodex(log?: Logger): Promise<CodexResolveResult> {
  const stagedPre = join(defaultStagingDir(), "codex.exe");

  // 1. env
  const envPath = process.env[ENV_VAR];
  if (envPath && existsSync(envPath)) {
    const v = tryVersion(envPath);
    if (v) {
      log?.info("codex resolved from env", { path: redactLocalPath(envPath), version: v });
      return { path: envPath, version: v, source: "env", staged: false };
    }
    log?.warn("env CAR_CODEX_EXEC set but not runnable", { path: redactLocalPath(envPath) });
  }

  // 2. existing staging
  if (existsSync(stagedPre)) {
    const v = tryVersion(stagedPre);
    if (v) {
      // 能跑不等于完整：老暂存区可能缺 code-mode-host 之类的配套文件，
      // 那种情况下 codex.exe 握手一切正常，但 agent 跑不了任何命令。
      repairStaging(log);
      log?.info("codex resolved from staging", { path: redactLocalPath(stagedPre), version: v });
      return { path: stagedPre, version: v, source: "staged", staged: true };
    }
    log?.warn("staged codex exists but not runnable, will re-stage", { path: redactLocalPath(stagedPre) });
  }

  // 3. PATH
  const pathExe = which("codex");
  if (pathExe) {
    const v = tryVersion(pathExe);
    if (v) {
      log?.info("codex resolved from PATH", { path: redactLocalPath(pathExe), version: v });
      return { path: pathExe, version: v, source: "path", staged: false };
    }
  }

  // 4. WindowsApps bundled -> stage
  const src = candidateWindowsAppsCodex();
  if (!src) {
    throw new Error(
      "Codex 未找到。请安装 Codex 桌面版/CLI，或通过环境变量 " + ENV_VAR + " 指定 codex 可执行路径。"
    );
  }
  log?.info("staging codex from WindowsApps", { src: redactLocalPath(src), dest: redactLocalPath(defaultStagingDir()) });
  mkdirSync(defaultStagingDir(), { recursive: true });
  copyFileSync(src, stagedPre);
  // 拷贝 codex 运行时需要的同级条目（清单见 STAGED_SIBLINGS；漏一个就会在运行期炸）
  const srcDir = dirname(src);
  const copied = stageSiblingsFrom(srcDir);
  const stillMissing = missingStagedSiblings();
  if (stillMissing.length) {
    log?.warn("staged codex is missing runtime siblings", { missing: stillMissing });
  } else {
    log?.info("staged codex siblings ok", { copied });
  }
  const v = tryVersion(stagedPre);
  if (!v) {
    throw new Error("从 WindowsApps 暂存 codex 后仍无法运行，请检查 Codex 安装完整性。");
  }
  log?.info("codex staged ok", { path: redactLocalPath(stagedPre), version: v });
  return { path: stagedPre, version: v, source: "windowsapps", staged: true };
}

function which(cmd: string): string | null {
  const exts = (process.env.PATHEXT ?? ".EXE").split(";").map((e) => e.toUpperCase());
  const dirs = (process.env.PATH ?? "").split(";").filter(Boolean);
  for (const d of dirs) {
    try {
      for (const e of exts) {
        const p = join(d, cmd + (cmd.toLowerCase().endsWith(e.toLowerCase()) ? "" : e));
        if (existsSync(p)) return p;
      }
    } catch { /* ignore */ }
  }
  return null;
}
