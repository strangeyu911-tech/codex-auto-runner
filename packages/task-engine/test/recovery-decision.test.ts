import { describe, it, expect } from "vitest";
import {
  RECOVERY_NEEDS_CONFIRM,
  RECOVERY_QUOTA_DEFERRED,
  decideRecovery,
} from "../src/index.js";

/**
 * 进程重启后的恢复判定。
 *
 * 这条判定决定「撞 5h / 进程崩了之后，用户还要不要醒来点一下」。
 * 之所以值得单测：它同时踩在两个相反的风险上 ——
 *   · 判宽了：把用户主动停掉的线程也自动跑起来（烧额度、还改用户的仓库）
 *   · 判窄了：退化成老行为，用户每次都得手动续跑
 * 所以每个边界都要钉住。
 */
describe("decideRecovery", () => {
  const turns = (...statuses: string[]) => statuses.map((s, i) => ({ id: `t${i + 1}`, status: s }));

  it("keeps quota semantics when the task itself recorded a quota hit", () => {
    const d = decideRecovery({ quotaHit: true, threadReadable: true, turns: turns("completed") });
    expect(d.action).toBe("WAITING_QUOTA");
    expect(d.lastError).toBe(RECOVERY_QUOTA_DEFERRED);
  });

  it("prefers quota semantics even when the thread is unreadable", () => {
    const d = decideRecovery({ quotaHit: true, threadReadable: false, turns: undefined });
    expect(d.action).toBe("WAITING_QUOTA");
  });

  it("parks for the user when the thread history cannot be read (fail closed)", () => {
    const d = decideRecovery({ quotaHit: false, threadReadable: false, turns: undefined });
    expect(d.action).toBe("WAITING_USER");
    expect(d.lastError).toBe(RECOVERY_NEEDS_CONFIRM);
    expect(d.why).toContain("unreadable");
  });

  it("parks for the user when the thread has no turns at all", () => {
    const d = decideRecovery({ quotaHit: false, threadReadable: true, turns: [] });
    expect(d.action).toBe("WAITING_USER");
    expect(d.why).toContain("no turns");
  });

  it("parks for the user when the last turn completed before the crash", () => {
    const d = decideRecovery({
      quotaHit: false,
      threadReadable: true,
      turns: turns("completed", "completed"),
    });
    expect(d.action).toBe("WAITING_USER");
    expect(d.lastTurnStatus).toBe("completed");
    expect(d.why).toContain("may be waiting for a human");
  });

  it("resumes when the last turn was interrupted (the CAR-restart case)", () => {
    const d = decideRecovery({
      quotaHit: false,
      threadReadable: true,
      // 实测形态：额度失败先发生，之后 CAR 自己那次续跑被进程死亡掐断成 interrupted
      turns: [
        { id: "t1", status: "failed" },
        { id: "t2", status: "interrupted" },
      ],
    });
    expect(d.action).toBe("READY");
    expect(d.lastError).toBe(null);
    expect(d.lastTurnStatus).toBe("interrupted");
  });

  it("resumes when the last turn failed for a non-quota reason", () => {
    const d = decideRecovery({ quotaHit: false, threadReadable: true, turns: turns("failed") });
    expect(d.action).toBe("READY");
    expect(d.lastTurnStatus).toBe("failed");
  });

  it("resumes when the last turn never left inProgress", () => {
    const d = decideRecovery({ quotaHit: false, threadReadable: true, turns: turns("inProgress") });
    expect(d.action).toBe("READY");
  });

  it("only looks at the LAST turn — an older interruption does not matter", () => {
    const d = decideRecovery({
      quotaHit: false,
      threadReadable: true,
      turns: turns("interrupted", "completed"),
    });
    expect(d.action).toBe("WAITING_USER");
  });

  it("fails closed on an unrecognised or missing last-turn status", () => {
    const unknown = decideRecovery({ quotaHit: false, threadReadable: true, turns: turns("weird") });
    expect(unknown.action).toBe("WAITING_USER");
    expect(unknown.why).toContain("fail closed");

    const missing = decideRecovery({
      quotaHit: false,
      threadReadable: true,
      turns: [{ id: "t1" }],
    });
    expect(missing.action).toBe("WAITING_USER");
    expect(missing.lastTurnStatus).toBe(null);
  });
});
