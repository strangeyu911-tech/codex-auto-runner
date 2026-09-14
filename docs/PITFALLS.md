# 已知陷阱（Pitfalls）

> 本项目大量依赖 Codex app-server 的半公开协议，以及 Codex 桌面版在 `%USERPROFILE%` 下维护的本地状态。
> 下面每一条都在真机上验证过，重复踩中的代价很高——其中几条会**静默**烧掉整轮额度。改代码前请先读这一页。

---

## 1. 最近一轮改动（2026-09-14 → 09-15）

| 提交 | 内容 |
|---|---|
| `fa657f2` | 新增 `@car/desktop-registry`，把 CAR 建立的线程登记进桌面版侧边栏成员表；daemon 每 2 分钟自愈扫描；新增 `car desktop status` / `car desktop fix` |
| `70b0308` | `car desktop fix` 的回读自检从「1.5 秒看一次」改成 2s → 6s → 12s 轮询；登记被覆盖时如实报警，不再给假的「成功」 |
| `1992a14` | 已登记的线程回读真实 `projectId`，不再一律显示「未分组」 |
| `b20a61b` | 续跑观感：首轮发完整指令、后续轮只发一句「继续任务。」；不再用 `outputSchema` 逼模型输出 JSON；结构化状态改由项目内 `.car/status.json` 承载，并支持原生信号兜底 |
| `53817b6` | 修正 `turn/completed` 中助手文本的取值形状（见 §2.3）——这条不修会静默导致无限续跑 |

---

## 2. Codex app-server 协议

### 2.1 `outputSchema` 约束的是「用户可见的最终消息」

`turn/start` 的 `outputSchema` 官方定义是 *constrain the final assistant message for this turn*，
也就是说——模型按 schema 输出的那份 JSON，**本身就是用户在对话里看到的那条回复**。

推论：**「让模型返回结构化状态」与「对话看起来像正常对话」在协议层天然冲突**。
本项目因此不再使用 `outputSchema`，改由项目内的 `.car/status.json` 承载状态
（`CAR_STATUS_FILE=0` 可回退到「解析回复正文里的 JSON」）。

### 2.2 `turn/start` 没有「不可见上下文」通道

`UserInput` 只有 `text` / `image` / `localImage` / `skill` / `mention` 五种变体，全都是可见消息；
`AdditionalContextEntry` 只出现在 `TurnSteerParams` 上，且其 `kind` 枚举是 `untrusted | application`，不是这条路的解法。

推论：**注入给模型的指令无法隐藏，只能把它写短。** 本项目首轮发完整指令，第 2 轮起只发一句「继续任务。」。

### 2.3 🔴 助手文本在 `turn.items[].text`，不在 `content[]`

`turn/completed` 通知里每条 item 的真实形状（codex 0.153.4 实测）是：

```text
{ type: "agentMessage", id, text, phase, memoryCitation, delivery, questions }
```

注意 `text` **直接挂在 item 上**，没有嵌套的 `content[]` 数组。

曾经的实现读的是 `items[].content[].text`，于是永远拿到空数组 → 静默返回 `null` → 把模型的
`needs_user` 读成 `needs_continue` → **任务永远停不下来，反复续跑、反复烧额度**。

正确取值优先级：

1. `phase === "final_answer"` 的 item；
2. `type === "agentMessage"` 的 item；
3. 其余 item（同时兼容旧式的 `content[]` 形状）。

### 2.4 原生状态信号可以替代「让模型报状态」

| 信号 | 取值 | 映射 |
|---|---|---|
| `thread/goal/get { threadId }` → `goal.status` | `active` / `paused` / `blocked` / `usageLimited` / `budgetLimited` / `complete` | `blocked` → 需要人工介入；`complete` → 完成 |
| `thread/status/changed` → `active.activeFlags` | `waitingOnApproval` / `waitingOnUserInput` | 需要人工介入 |

⚠️ 时序陷阱：CAR 会在 `thread/resume` 之前把 `blocked` / `complete` 的 goal 拉回 `active`，
所以**读 goal 状态必须卡在「本轮刚结束」那一刻**，否则永远读到 `active`。

### 2.5 `thread/fork` 不碰父线程的写锁

`thread/fork` 是血缘分叉：子 rollout 的 `session_meta` 带 `forked_from_id` 与
`forked_from_ordinal_exclusive`，ordinal 从分叉点续编；父历史靠引用继承。

- 父线程**正被持锁**时 fork 依然成功，且父锁文件 mtime 逐字未变 → 这是写锁冲突时的正解。
- `ThreadForkParams` 必填只有 `threadId`，可选 `lastTurnId`（fork through, inclusive）与 `excludeTurns`。
- `threadSource` 只是 analytics 字段，**与侧边栏可见性无关**（早期关于它控制可见性的假设已被证伪）。

取 schema 的正确方式：

```bash
codex app-server generate-json-schema --out <临时目录>
```

⚠️ 不要跑仓库自带的 `pnpm schema:gen`——它会 `rmSync` 掉 `schemas/generated/` 下的既有版本目录。

---

## 3. Codex 桌面版侧边栏的可见性

**侧边栏不读 `thread/list`。** 它渲染的是自己维护的成员表，位于 Codex 私有状态文件
`.codex-global-state.json`（在 `%USERPROFILE%` 下）：

- `thread-project-assignments`（线程 → 项目）
- `sidebar-project-thread-orders`（项目 → 线程顺序）
- `projectless-thread-ids`（未分组）
- `thread-workspace-root-hints`（线程 → 工作目录）

关键事实：

1. **桌面版没有启动期对账。** 它只在你手动新建 / 选择 / 编辑 / 删除项目根路径时才扫描并认领
   未分组线程，所以外部建立的线程永远不会自己冒出来。
2. **时序决定成败。** 桌面版启动时把该文件读进内存，之后按内存写盘：
   - 写入发生在它**启动之前** → 稳定存活（实测：开着桌面版也能存活 60 分钟以上）；
   - 写入发生在它**运行期间** → 会被下一次写盘整文件覆盖（实测：写入后当场可读、活了 90 秒、约 11 分钟后被抹回 `undefined`）。
   - 可靠顺序：**完全退出桌面版 → 写入（`car desktop fix`，或等 daemon 的 2 分钟自愈扫描）→ 再打开桌面版。**

3. **判断桌面版是否在运行，不能只看进程名。** 至少有两个来源的 `codex.exe`：桌面版本体，
   以及 CAR 自己拉起的 app-server（父进程是 daemon）。必须比对可执行文件的完整路径。

4. 写入必须**只增不删**，带 `size` / `mtimeMs` 并发校验、同目录 tmp + rename 原子替换，
   解析失败一律放弃，绝不新建或清空该文件。`CAR_DESKTOP_REGISTRY=0` 可整体关闭。

---

## 4. 测试

- 🔴 **测试夹具必须使用真实载荷形状。** 本项目曾经因为夹具喂了
  `{ type: "message", role: "assistant", content: [{ type: "output_text" }] }` 这种现实中不存在的形状，
  导致 11 条测试全绿、而真机每次解析都失败。**假形状的夹具比没有测试更危险。**
- 任何涉及「解析外部协议」的改动，先用真实运行记录核对形状，再写断言。
  本机的 `runner.db` 事件表里存有真实的 `turn/completed` 载荷，可以只读 dump 出来对照。
- 根目录 `test/` 依赖 `node:sqlite`，**不能进 vitest**，只能用 `node --test` 运行；
  其余套件（含 `apps/daemon/test/*`）走 `tsx --test`。

---

## 5. 本机（Windows）开发环境的坑

- **没有 pnpm、corepack 失效**：一律直接调 `node node_modules/<pkg>/...`
  —— tsx 用 `tsx/dist/cli.mjs`，vitest 用 `vitest/vitest.mjs run`，
  tsc 用 `typescript/bin/tsc -p <tsconfig> --noEmit`。
- **Bash 无常驻 coreutils**：`cat` / `ls` / `grep` / `head` / `tail` / `mv` / `rm` 可能 `command not found`。
  文件操作改用 `node -e` + `fs` 模块，读文件用编辑器的 Read 工具。
- **`node -e "…"` 的双引号里有两个雷**：
  ① Windows 路径反斜杠会被吞（`D:\x` 变成 `D:x`）；
  ② 反引号会被当成命令替换，内容被整段吃掉且会刷出假的「文件不存在」错误。
  → 凡内容里含反斜杠或反引号，一律落成独立的 `.mjs` 文件再执行。
- **PowerShell 工具不回传 stdout**：用 `Out-File` 写入文件后再读。
- **`wmic` 已被移除**：枚举进程改用 `Get-CimInstance Win32_Process`。
- **Git Bash 会把 `//FI` 当路径转换吃掉**（`tasklist //FI ...` 参数丢失）：
  改用 `execFileSync("tasklist", ["/FI", ...])`。

---

## 6. 隐私与提交

- `scripts/privacy-check.ts` 也扫描**未跟踪**的文件（它跑的是
  `git ls-files --cached --others --exclude-standard`）。所以只要文件躺在工作树里且没被 gitignore，就会被扫。
- 审计材料、会话对照、进程快照一律放 `_audit/`（已在 `.gitignore` 中忽略），不要放进仓库目录。
- 写文档时避开这些形态：Windows 用户目录的绝对路径（用 `%USERPROFILE%` 代替）、
  Codex 私有会话/附件目录、以及各类密钥字面量（以 `sk-` 开头的密钥、GitHub 令牌、
  `Authorization` 头中的 Bearer 令牌、`OPENAI_API_KEY` 形式的赋值、`x-api-key` 字面量）。
- 注意 `privacy-check` 把 `status.json` 归入「用户本地运行时文件」。因此
  **`.car/status.json` 绝不能提交进任何仓库**——它属于任务项目目录，并且会被写进该仓库的
  `.git/info/exclude`（而不是改动被跟踪的 `.gitignore`）。
