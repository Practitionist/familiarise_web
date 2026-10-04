/**
 * @jest-environment node
 */

import {
  computeConsultantCompletionRate,
  NON_HOST_UNVERIFIED_REASONS,
} from "../../lib/data/consultant-dashboard";

describe("computeConsultantCompletionRate", () => {
  it("excludes OFFLINE, INCONCLUSIVE, NOBODY_JOINED, and CONSULTEE_NO_SHOW UNVERIFIED rows from penalizing completionRate", () => {
    for (const reason of NON_HOST_UNVERIFIED_REASONS) {
      const rate = computeConsultantCompletionRate([
        { completionStatus: "COMPLETED", outcome: "HELD", _count: 8 },
        { completionStatus: "UNVERIFIED", outcome: reason, _count: 2 },
      ]);
      expect(rate).toBe(100);
    }
  });

  it("still counts legacy UNVERIFIED rows without a non-host-fault reason or host-attributed voids in the denominator", () => {
    const rate = computeConsultantCompletionRate([
      { completionStatus: "COMPLETED", outcome: "HELD", _count: 3 },
      { completionStatus: "UNVERIFIED", outcome: null, _count: 1 },
      { completionStatus: "VOIDED", outcome: "HOST_ABSENT", _count: 1 },
      { completionStatus: "VOIDED", outcome: "PLATFORM_OUTAGE", _count: 5 },
    ]);
    // 3 completed out of (3 completed + 1 legacy unverified + 1 host voided) = 60%
    expect(rate).toBe(60);
  });

  it("returns null when no countable occurrences exist", () => {
    const rate = computeConsultantCompletionRate([
      { completionStatus: "UNVERIFIED", outcome: "OFFLINE", _count: 2 },
      { completionStatus: "UNVERIFIED", outcome: "INCONCLUSIVE", _count: 1 },
    ]);
    expect(rate).toBeNull();
  });
});
