import { describe, it, expect } from "vitest";
import { probeQuotaInterrupted } from "../src/index.js";

/**
 * 第 5 项（resumeThread 续跑校验）的核心判据。
 *
 * 之所以单独抽出来测：goal 侧的 thread/goal/get 对无 goal 线程返回 goal=null，
 * 无法用于识别「被 5h 限额打断」；只有 turn 历史与 goal 无关，对两类线程都成立。
 */
describe("probeQuotaInterrupted", () => {
  it("returns not-interrupted for an empty / undefined turn list", () => {
    expect(probeQuotaInterrupted(undefined).interrupted).toBe(false);
    expect(probeQuotaInterrupted([]).interrupted).toBe(false);
  });

  it("detects usageLimitExceeded on a failed last turn", () => {
    const probe = probeQuotaInterrupted([
      { id: "t1", status: "completed" },
      {
        id: "t2",
        status: "failed",
        error: { message: "You've hit your usage limit", codexErrorInfo: "usageLimitExceeded" },
      },
    ]);
    expect(probe.interrupted).toBe(true);
    expect(probe.turnId).toBe("t2");
    expect(probe.turnStatus).toBe("failed");
    expect(probe.errorInfo).toBe("usageLimitExceeded");
  });

  it("detects quota wording in the error message even without codexErrorInfo", () => {
    const probe = probeQuotaInterrupted([
      { id: "t1", status: "failed", error: { message: "rate limit reached, try later" } },
    ]);
    expect(probe.interrupted).toBe(true);
  });

  it("detects Chinese quota wording", () => {
    const probe = probeQuotaInterrupted([
      { id: "t1", status: "failed", error: { message: "已达到使用限制" } },
    ]);
    expect(probe.interrupted).toBe(true);
  });

  it("treats an interrupted turn with a quota message as interrupted", () => {
    const probe = probeQuotaInterrupted([
      { id: "t1", status: "interrupted", error: { message: "quota exceeded" } },
    ]);
    expect(probe.interrupted).toBe(true);
    expect(probe.turnStatus).toBe("interrupted");
  });

  it("does NOT flag a completed turn", () => {
    const probe = probeQuotaInterrupted([
      { id: "t1", status: "completed", error: { message: "usage limit", codexErrorInfo: "usageLimitExceeded" } },
    ]);
    expect(probe.interrupted).toBe(false);
    expect(probe.turnStatus).toBe("completed");
  });

  it("does NOT flag an inProgress turn", () => {
    const probe = probeQuotaInterrupted([{ id: "t1", status: "inProgress" }]);
    expect(probe.interrupted).toBe(false);
  });

  it("does NOT flag a failed turn for unrelated reasons", () => {
    const probe = probeQuotaInterrupted([
      { id: "t1", status: "failed", error: { message: "sandbox write denied", codexErrorInfo: "sandboxError" } },
    ]);
    expect(probe.interrupted).toBe(false);
    expect(probe.errorInfo).toBe("sandboxError");
  });

  it("only inspects the LAST turn (an older quota failure is stale)", () => {
    const probe = probeQuotaInterrupted([
      { id: "t1", status: "failed", error: { message: "usage limit", codexErrorInfo: "usageLimitExceeded" } },
      { id: "t2", status: "completed" },
    ]);
    expect(probe.interrupted).toBe(false);
    expect(probe.turnId).toBe("t2");
  });

  it("handles a turn with a null error object", () => {
    const probe = probeQuotaInterrupted([{ id: "t1", status: "failed", error: null }]);
    expect(probe.interrupted).toBe(false);
    expect(probe.errorInfo).toBe(null);
  });
});
