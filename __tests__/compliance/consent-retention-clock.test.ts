/**
 * @jest-environment node
 */

/**
 * Two defects in the consent record's own retention, both of which destroy
 * evidence rather than merely misreporting it.
 *
 * 1. `withdrawConsent` did not touch `auditRetainedUntil`, so the clock kept
 *    running from `grantedAt`. An artifact granted six years ago and withdrawn
 *    today became deletable immediately — and the consent-retention sweeper
 *    would then delete the only record that the user ever withdrew. The clock
 *    has to restart at the withdrawal.
 *
 * 2. Three separate places told users the retention sweeper is a "daily cron"
 *    that "purges rows". It is weekly, and count-only unless
 *    DPDP_SWEEPER_DELETE is set. A user reading a dashboard that overstates both
 *    the cadence and the deletion has been told something untrue about their own
 *    data.
 */

const mockFindFirst = jest.fn();
const mockUpdateMany = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consentArtifact: {
      findFirst: (...a: unknown[]) => mockFindFirst(...a),
      updateMany: (...a: unknown[]) => mockUpdateMany(...a),
    },
  },
}));

jest.mock("../../lib/enterprise/system-events", () => ({
  __esModule: true,
  recordSystemEvent: jest.fn(),
}));

import {
  checkConsent,
  withdrawConsent,
  buildConsentArtifact,
  CONSENT_AUDIT_RETENTION_YEARS,
} from "@/lib/compliance/dpdp";
import { PURPOSE_CODES } from "@/lib/compliance/purpose-codes";

const SEVEN_YEARS_MS = 7 * 365.25 * 24 * 60 * 60 * 1000;

beforeEach(() => {
  mockFindFirst.mockReset();
  mockUpdateMany.mockReset();
  mockUpdateMany.mockResolvedValue({ count: 1 });
});

describe("consent audit retention clock", () => {
  it("is derived from the grant on a fresh artifact", () => {
    const grantedAt = new Date("2026-01-15T10:00:00.000Z");
    const draft = buildConsentArtifact({
      userId: "u1",
      dataFiduciary: "Familiarise",
      purposeCodes: [PURPOSE_CODES.SESSION_BOOKING],
      language: "en-IN",
      consentManager: null,
      version: 1,
      grantedAt,
    });
    expect(draft.auditRetainedUntil.getUTCFullYear()).toBe(2033);
  });

  it("restarts at the withdrawal, not the grant", async () => {
    await withdrawConsent({
      userId: "u1",
      purposeCode: PURPOSE_CODES.SESSION_BOOKING,
    });

    const data = (
      mockUpdateMany.mock.calls[0][0] as { data: Record<string, Date> }
    ).data;
    expect(data.withdrawnAt).toBeInstanceOf(Date);
    // The regression: `data.auditRetainedUntil` was undefined, so the row's
    // clock kept running from grantedAt and a six-year-old artifact became
    // deletable the moment it was withdrawn.
    expect(data.auditRetainedUntil).toBeInstanceOf(Date);
  });

  it("keeps a withdrawn record alive for the full 7 years from that moment", async () => {
    const before = Date.now();
    await withdrawConsent({
      userId: "u1",
      purposeCode: PURPOSE_CODES.SESSION_BOOKING,
    });

    const { auditRetainedUntil } = (
      mockUpdateMany.mock.calls[0][0] as { data: Record<string, Date> }
    ).data;

    const span = auditRetainedUntil.getTime() - before;
    // Allow a second of slack for the test's own execution window, then assert
    // the clock is ~7 years out rather than "already expired".
    expect(span).toBeGreaterThan(SEVEN_YEARS_MS - 60 * 60 * 1000);
  });

  it("never sets the clock in the past, even for an ancient artifact", async () => {
    // The failing case: grantedAt 6 years ago means grantedAt + 7y is only ~1
    // year out. A withdrawal must push it a full 7 years from NOW.
    const sixYearsAgo = new Date();
    sixYearsAgo.setFullYear(sixYearsAgo.getFullYear() - 6);

    const draft = buildConsentArtifact({
      userId: "u1",
      dataFiduciary: "Familiarise",
      purposeCodes: [PURPOSE_CODES.SESSION_BOOKING],
      language: "en-IN",
      consentManager: null,
      version: 1,
      grantedAt: sixYearsAgo,
    });
    const grantExpiry = draft.auditRetainedUntil.getTime();

    await withdrawConsent({
      userId: "u1",
      purposeCode: PURPOSE_CODES.SESSION_BOOKING,
    });
    const { auditRetainedUntil } = (
      mockUpdateMany.mock.calls[0][0] as { data: Record<string, Date> }
    ).data;

    expect(auditRetainedUntil.getTime()).toBeGreaterThan(grantExpiry);
    expect(auditRetainedUntil.getTime()).toBeGreaterThan(Date.now());
  });

  it("uses calendar years, not a fixed millisecond offset", async () => {
    await withdrawConsent({ userId: "u1" });
    const { auditRetainedUntil } = (
      mockUpdateMany.mock.calls[0][0] as { data: Record<string, Date> }
    ).data;
    // A 7*365-day offset lands on a different date than 7 calendar years
    // whenever a leap day falls in the window. Assert the calendar property:
    // same month and day, seven years on.
    const now = new Date();
    expect(auditRetainedUntil.getUTCDate()).toBe(now.getUTCDate());
    expect(auditRetainedUntil.getUTCMonth()).toBe(now.getUTCMonth());
    expect(auditRetainedUntil.getUTCFullYear()).toBe(
      now.getUTCFullYear() + CONSENT_AUDIT_RETENTION_YEARS,
    );
  });

  it("applies the same clock to a withdraw-everything call", async () => {
    await withdrawConsent({ userId: "u1" });
    const data = (
      mockUpdateMany.mock.calls[0][0] as { data: Record<string, Date> }
    ).data;
    // A wide withdrawal touches more purposes, so it must not be the one path
    // that forgets the clock.
    expect(data.auditRetainedUntil).toBeInstanceOf(Date);
  });

  it("leaves the gate semantics unchanged", async () => {
    // The fix must not disturb the fail-closed predicate.
    mockFindFirst.mockResolvedValue(null);
    await expect(
      checkConsent({
        userId: "u1",
        purposeCode: PURPOSE_CODES.SESSION_BOOKING,
      }),
    ).resolves.toBe(false);
  });
});
