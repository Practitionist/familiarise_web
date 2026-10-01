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

import { execFileSync } from "node:child_process";

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
    const before = new Date();
    await withdrawConsent({
      userId: "u1",
      purposeCode: PURPOSE_CODES.SESSION_BOOKING,
    });

    const { auditRetainedUntil } = (
      mockUpdateMany.mock.calls[0][0] as { data: Record<string, Date> }
    ).data;

    // Deliberately NOT a fixed millisecond threshold. A 7-calendar-year window
    // contains either one or two leap days, so its length is 2556 or 2557 days
    // while `7 * 365.25` is 2556.75 — a fixed threshold passes only on the
    // two-leap-day years and fails on the one-leap-day ones. That is a
    // date-dependent flake which surfaces in 2028 and again in 2032.
    // The always-safe bounds: at least 7 * 365 days, and at most 7 * 366,
    // since no 7-year window can contain three leap days.
    const spanDays =
      (auditRetainedUntil.getTime() - before.getTime()) / (24 * 60 * 60 * 1000);
    expect(spanDays).toBeGreaterThan(7 * 365 - 1);
    expect(spanDays).toBeLessThan(7 * 366 + 1);
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
    const before = new Date();
    await withdrawConsent({ userId: "u1" });
    const { auditRetainedUntil } = (
      mockUpdateMany.mock.calls[0][0] as { data: Record<string, Date> }
    ).data;
    // A 7*365-day offset lands on a different date than 7 calendar years
    // whenever a leap day falls in the window. Assert the calendar property:
    // same month and day, seven years on.
    expect(auditRetainedUntil.getUTCDate()).toBe(before.getUTCDate());
    expect(auditRetainedUntil.getUTCMonth()).toBe(before.getUTCMonth());
    expect(auditRetainedUntil.getUTCFullYear()).toBe(
      before.getUTCFullYear() + CONSENT_AUDIT_RETENTION_YEARS,
    );
  });

  it("computes the deadline in UTC, not the host's local zone", async () => {
    // A DST transition inside the retention window shifts a local-time
    // computation by an hour, and the sweeper compares this value directly — so
    // a deadline computed in local time can become eligible for deletion an
    // hour early.
    //
    // The instant is FROZEN at a DST boundary rather than taken from `now`.
    // A `new Date()`-based version of this test is only able to catch the bug
    // when the suite happens to run near a transition — the same
    // date-dependence this file already flagged once. 2026-03-08T07:00Z is
    // the first hour for which local and UTC year-arithmetic diverge under
    // America/New_York, which is the zone Netlify's own docs warn about for
    // serverless scheduling.
    const before = new Date("2026-03-08T07:00:00.000Z");
    jest.useFakeTimers({ now: before });
    try {
      await withdrawConsent({ userId: "u1" });
      const { auditRetainedUntil } = (
        mockUpdateMany.mock.calls[0][0] as { data: Record<string, Date> }
      ).data;

      const expected = new Date(before);
      expected.setUTCFullYear(
        expected.getUTCFullYear() + CONSENT_AUDIT_RETENTION_YEARS,
      );
      expect(auditRetainedUntil.toISOString()).toBe(expected.toISOString());
    } finally {
      jest.useRealTimers();
    }
  });

  it("would have differed under a DST zone, which is why the UTC fix matters", () => {
    // Proves the assertion above has teeth.
    //
    // A `process.env.TZ` change does not work here: V8 caches the timezone, so
    // a runtime change does not take effect and the test would pass or fail
    // depending on the host. A child process with the zone set at launch is
    // the only deterministic way to exercise a different zone, so this is the
    // shape that makes the check reproducible on a developer laptop (IST, no
    // DST) and in CI (usually UTC) alike.
    const at = "2026-03-08T07:00:00.000Z";
    const script = `
      const b = new Date(${JSON.stringify(at)});
      const l = new Date(b); l.setFullYear(l.getFullYear() + ${CONSENT_AUDIT_RETENTION_YEARS});
      const u = new Date(b); u.setUTCFullYear(u.getUTCFullYear() + ${CONSENT_AUDIT_RETENTION_YEARS});
      process.stdout.write(String(l.getTime() - u.getTime()));
    `;
    const localMinusUtc = Number(
      execFileSync(process.execPath, ["-e", script], {
        env: { ...process.env, TZ: "America/New_York" },
        encoding: "utf8",
      }).trim(),
    );
    // One hour, the DST offset shift. If this ever becomes 0, the host Node no
    // longer observes the zone and the assertion above has lost its teeth —
    // revisit it rather than trusting it.
    expect(localMinusUtc).toBe(60 * 60 * 1000);
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
