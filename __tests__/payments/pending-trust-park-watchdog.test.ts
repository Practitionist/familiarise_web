/**
 * @jest-environment node
 */

/**
 * The PENDING_TRUST park watchdog is a detect-only reconcile-ledgers finding:
 * stale parks are grouped per withholding sponsor and nothing is released.
 */

import {
  groupPendingTrustParks,
  PENDING_TRUST_PARK_STALE_MS,
  type PendingTrustParkRow,
} from "../../scripts/reconcile/reconcile-ledgers";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-09-30T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * HOUR);

const parkRow = (
  earningId: string,
  sponsorOrganizationId: string,
  paise: number,
  createdAt: Date,
): PendingTrustParkRow => ({
  earningId,
  sponsorOrganizationId,
  amountPaise: paise,
  createdAt,
});

describe("PENDING_TRUST_PARK_STALE_MS", () => {
  it("is the doctrine's 24h hard window", () => {
    expect(PENDING_TRUST_PARK_STALE_MS).toBe(24 * HOUR);
  });
});

describe("groupPendingTrustParks", () => {
  it("groups by withholding sponsor, totals the paise, largest first", () => {
    const groups = groupPendingTrustParks([
      parkRow("e1", "orgA", 1_000, daysAgo(2)),
      parkRow("e2", "orgA", 500, daysAgo(1)),
      parkRow("e3", "orgB", 7_000, daysAgo(3)),
    ]);
    expect(groups.map((g) => g.organizationId)).toEqual(["orgB", "orgA"]);
    const a = groups[1];
    expect(a.parkedPaise).toBe(1_500);
    expect(a.earningCount).toBe(2);
    expect(a.oldestCreatedAt).toEqual(daysAgo(2));
  });
});
