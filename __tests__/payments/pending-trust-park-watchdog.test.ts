/**
 * @jest-environment node
 */

/**
 * #687 E-01/E-02 — the PENDING_TRUST park watchdog.
 *
 * Two things are pinned here, and the second matters more than the first:
 *
 *   1. A park that outlives the 24h hard window is DETECTED — it raises a
 *      PENDING_TRUST_PARK_STALE finding / alerts, and a recent one is not.
 *   2. NO age threshold ever releases the earning. The release pass is driven
 *      solely by the sponsor conditions (ACTIVE, or ≥1 PAID invoice), so a
 *      sponsor that does neither leaves the row PENDING_TRUST forever, however
 *      old it gets. Releasing on age would hand the money back to the
 *      invoice-fraud case the park exists to stop, so this is pinned as a
 *      property over a wide range of ages rather than a single assertion.
 */

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));

jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemEventSafe: jest.fn(() => Promise.resolve()),
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_name: string, _opts: unknown, fn: () => Promise<unknown>) =>
    fn(),
}));

jest.mock("../../lib/maintenance-cron", () => ({
  abortIfMaintenance: jest.fn(() => Promise.resolve()),
}));

jest.mock("../../lib/observability/job-sentry", () => ({
  runJob: jest.fn(),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  // Shape only — `seed()` fills the delegates in before each run. Built inside
  // the factory because jest hoists `jest.mock` above the module imports, so
  // a factory closing over a module-scope const would hit the TDZ.
  default: {
    consultantEarnings: {},
    organizationEarnings: {},
    organization: {},
    organizationInvoice: {},
    $disconnect: jest.fn(),
  },
}));

import prisma from "../../lib/prisma";
import { recordSystemEventSafe } from "../../lib/enterprise/system-events";
import {
  reportSentryError,
  reportSentryMessage,
} from "../../lib/observability/report";
import {
  groupPendingTrustParks,
  pendingTrustParkSeverity,
  PENDING_TRUST_PARK_PAGE_MS,
  PENDING_TRUST_PARK_WARN_MS,
  type PendingTrustParkRow,
} from "../../scripts/reconcile/reconcile-ledgers";
import { runReleasePendingTrustEarnings } from "../../jobs/cleanup/release-pending-trust-earnings";

const db = prisma as unknown as {
  consultantEarnings: {
    findMany: jest.Mock;
    updateMany: jest.Mock;
  };
  organizationEarnings: { findMany: jest.Mock; updateMany: jest.Mock };
  organization: { findMany: jest.Mock };
  organizationInvoice: { findMany: jest.Mock };
};

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-09-30T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * HOUR);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * HOUR);

// Prisma hands back BigInt for the money columns; the rows below are the
// shape `readParkedRows` selects.
const ceRow = (
  id: string,
  sponsorOrganizationId: string,
  paise: number,
  createdAt: Date,
) => ({
  id,
  consultantSharePaise: BigInt(paise),
  createdAt,
  payment: { organizationId: sponsorOrganizationId },
});

const oeRow = (
  id: string,
  organizationId: string,
  paise: number,
  createdAt: Date,
) => ({
  id,
  organizationId,
  orgSharePaise: BigInt(paise),
  createdAt,
});

const parkRow = (
  earningId: string,
  sponsorOrganizationId: string,
  paise: number,
  createdAt: Date,
): PendingTrustParkRow => ({
  earningId,
  table: "ConsultantEarnings",
  sponsorOrganizationId,
  amountPaise: paise,
  createdAt,
});

/**
 * The release job's three queries plus the two CAS writes. Defaults to a
 * healthy, fully-released world; each test overrides only what it exercises.
 */
function seed(args: {
  consultantParks?: ReturnType<typeof ceRow>[];
  orgParks?: ReturnType<typeof oeRow>[];
  verifiedOrgIds?: string[];
  paidOrgIds?: string[];
  releasedOrgCount?: number;
  releasedConsultantCount?: number;
}) {
  const {
    consultantParks = [],
    orgParks = [],
    verifiedOrgIds = [],
    paidOrgIds = [],
    releasedOrgCount = 0,
    releasedConsultantCount = 0,
  } = args;

  const consultantFindMany = jest.fn(async (q: { where?: unknown }) => {
    // The release pass narrows by unlocked sponsor; the watchdog reads all.
    const orgFilter = (
      q.where as { payment?: { organizationId?: { in?: string[] } } }
    )?.payment?.organizationId?.in;
    if (!orgFilter) return consultantParks;
    return consultantParks.filter((r) =>
      orgFilter.includes(r.payment.organizationId ?? ""),
    );
  });

  db.consultantEarnings = {
    findMany: consultantFindMany,
    updateMany: jest.fn(async () => ({ count: releasedConsultantCount })),
  };
  db.organizationEarnings = {
    findMany: jest.fn(async () => orgParks),
    updateMany: jest.fn(async () => ({ count: releasedOrgCount })),
  };
  db.organization = {
    findMany: jest.fn(async () => verifiedOrgIds.map((id) => ({ id }))),
  };
  db.organizationInvoice = {
    findMany: jest.fn(async () =>
      paidOrgIds.map((organizationId) => ({ organizationId })),
    ),
  };
}

// Pin the clock so the 24h/72h rungs are deterministic.
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
  jest.clearAllMocks();
  (recordSystemEventSafe as jest.Mock).mockResolvedValue(undefined);
});

afterEach(() => jest.useRealTimers());

// --- 1. detection -------------------------------------------------------

describe("pendingTrustParkSeverity", () => {
  it("pins the doctrine's thresholds at 24h warn / 72h page", () => {
    // Overridable by env for operators, but the DEFAULTS are the doctrine.
    expect(PENDING_TRUST_PARK_WARN_MS).toBe(24 * HOUR);
    expect(PENDING_TRUST_PARK_PAGE_MS).toBe(72 * HOUR);
  });

  it("grades a park older than the 24h hard window as WARN", () => {
    expect(pendingTrustParkSeverity(daysAgo(1.5), NOW)).toBe("WARN");
  });

  it("grades a park older than the page window as ERROR", () => {
    expect(pendingTrustParkSeverity(daysAgo(3.5), NOW)).toBe("ERROR");
  });

  it("leaves a recent park at NONE", () => {
    expect(pendingTrustParkSeverity(daysAgo(0.5), NOW)).toBe("NONE");
  });

  it("is exactly on the boundary at WARN, not before it", () => {
    // Explicit windows so the assertion does not move if an operator sets
    // PENDING_TRUST_PARK_WARN_MS in a deployed environment.
    const exact = new Date(NOW.getTime() - 24 * HOUR);
    expect(pendingTrustParkSeverity(exact, NOW, 24 * HOUR, 72 * HOUR)).toBe(
      "WARN",
    );
    expect(
      pendingTrustParkSeverity(
        new Date(exact.getTime() + 1),
        NOW,
        24 * HOUR,
        72 * HOUR,
      ),
    ).toBe("NONE");
  });

  it("never returns a release-shaped verdict for any age", () => {
    // The whole anti-fraud guard rests on this: age maps to a LEVEL only.
    for (const ageMs of [0, HOUR, 24 * HOUR, 72 * HOUR, 10 * 365 * 24 * HOUR]) {
      const verdict = pendingTrustParkSeverity(
        new Date(NOW.getTime() - ageMs),
        NOW,
      );
      expect(["NONE", "WARN", "ERROR"]).toContain(verdict);
    }
  });
});

describe("groupPendingTrustParks", () => {
  it("groups by withholding sponsor and totals the withheld paise", () => {
    const groups = groupPendingTrustParks(
      [
        parkRow("e1", "orgA", 1_000, daysAgo(2)),
        parkRow("e2", "orgA", 500, daysAgo(1)),
        parkRow("e3", "orgB", 7_000, daysAgo(0.1)),
      ],
      NOW,
    );
    expect(groups).toHaveLength(2);
    const a = groups.find((g) => g.organizationId === "orgA")!;
    expect(a.parkedPaise).toBe(1_500);
    expect(a.earningCount).toBe(2);
    // Graded on the OLDEST row in the group — one ancient row is the stall.
    expect(a.severity).toBe("WARN");
    // The recent-only sponsor is not a finding at all.
    expect(groups.find((g) => g.organizationId === "orgB")!.severity).toBe(
      "NONE",
    );
  });
});

describe("runReleasePendingTrustEarnings — parked rows are surfaced", () => {
  it("raises a SystemEvent and a non-paging report for a 30h-old park", async () => {
    seed({
      consultantParks: [ceRow("ce1", "orgA", 12_000, daysAgo(1.25))],
      orgParks: [oeRow("oe1", "orgA", 4_000, daysAgo(1.25))],
      verifiedOrgIds: [],
      paidOrgIds: [],
    });

    const r = await runReleasePendingTrustEarnings();

    expect(r.stalledOrgs).toBe(1);
    expect(r.pagedOrgs).toBe(0);
    expect(r.stalledPaise).toBe(16_000);
    expect(r.stillParked).toBe(2);
    // WARN → durable operator row, but not an incident.
    expect(recordSystemEventSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "orgA",
        category: "PAYOUT",
        severity: "WARN",
      }),
    );
    expect(reportSentryMessage).toHaveBeenCalled();
    expect(reportSentryError).not.toHaveBeenCalled();
  });

  it("escalates a 4-day-old park to an ERROR SystemEvent and pages", async () => {
    seed({
      consultantParks: [ceRow("ce1", "orgA", 12_000, daysAgo(4))],
    });

    const r = await runReleasePendingTrustEarnings();

    expect(r.pagedOrgs).toBe(1);
    expect(recordSystemEventSafe).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "ERROR" }),
    );
    // reportSentryError with expected:false leaves Sentry's error level in
    // place, which is what an alert rule fires on.
    expect(reportSentryError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ expected: false }),
    );
  });

  it("stays silent for a park that is only hours old", async () => {
    seed({
      consultantParks: [
        ceRow("ce1", "orgA", 12_000, new Date(NOW.getTime() - 2 * HOUR)),
      ],
    });

    const r = await runReleasePendingTrustEarnings();

    expect(r.stalledOrgs).toBe(0);
    expect(r.stillParked).toBe(1);
    expect(recordSystemEventSafe).not.toHaveBeenCalled();
    expect(reportSentryMessage).not.toHaveBeenCalled();
    expect(reportSentryError).not.toHaveBeenCalled();
  });

  it("detects a stalled park when NO sponsor has unlocked — the short-circuit case", async () => {
    // `unlockedOrgIds` is empty here, so the release pass returns immediately.
    // The watchdog has to have run before that, or this stall is invisible.
    seed({
      consultantParks: [ceRow("ce1", "orgA", 12_000, daysAgo(5))],
      verifiedOrgIds: [],
      paidOrgIds: [],
    });

    const r = await runReleasePendingTrustEarnings();

    expect(r.released).toBe(0);
    expect(r.pagedOrgs).toBe(1);
    expect(reportSentryError).toHaveBeenCalled();
  });
});

// --- 2. release behaviour is unchanged, and age never releases ------------

describe("runReleasePendingTrustEarnings — release is condition-driven only", () => {
  it("releases a parked row for a sponsor that went ACTIVE", async () => {
    seed({
      consultantParks: [ceRow("ce1", "orgA", 12_000, daysAgo(0.5))],
      orgParks: [oeRow("oe1", "orgA", 4_000, daysAgo(0.5))],
      verifiedOrgIds: ["orgA"],
      releasedOrgCount: 1,
      releasedConsultantCount: 1,
    });

    const r = await runReleasePendingTrustEarnings();

    expect(r.released).toBe(2);
    expect(r.scanned).toBe(2);
    expect(r.stillParked).toBe(0);
    // Fresh park, so nothing to escalate.
    expect(r.stalledOrgs).toBe(0);
  });

  it("releases a parked row for a sponsor that paid an invoice (never verified)", async () => {
    seed({
      consultantParks: [ceRow("ce1", "orgA", 12_000, daysAgo(0.5))],
      verifiedOrgIds: [],
      paidOrgIds: ["orgA"],
      releasedConsultantCount: 1,
    });

    const r = await runReleasePendingTrustEarnings();

    expect(r.released).toBe(1);
  });

  it("NEVER releases on age, at any age", async () => {
    // A sponsor that does neither condition, across a span from 25 hours to
    // five years. Every one of these must stay PENDING_TRUST forever: no
    // updateMany may be called, whatever the age.
    for (const ageHours of [25, 48, 72, 24 * 30, 24 * 365 * 5]) {
      seed({
        consultantParks: [
          ceRow(
            "ce1",
            "orgA",
            12_000,
            new Date(NOW.getTime() - ageHours * HOUR),
          ),
        ],
        orgParks: [
          oeRow(
            "oe1",
            "orgA",
            4_000,
            new Date(NOW.getTime() - ageHours * HOUR),
          ),
        ],
        verifiedOrgIds: [],
        paidOrgIds: [],
        releasedOrgCount: 0,
        releasedConsultantCount: 0,
      });

      const r = await runReleasePendingTrustEarnings();

      expect(r.released).toBe(0);
      expect(r.stillParked).toBe(2);
      // The rows are un-parkable, so the CAS is never even attempted.
      expect(db.consultantEarnings.updateMany).not.toHaveBeenCalled();
      expect(db.organizationEarnings.updateMany).not.toHaveBeenCalled();
      // The escalation is a report, never a payout. Asserted as "an
      // escalation fired" rather than "the pager fired": the ladder is
      // warn-then-page, so the 25h and 48h cases only warn. The pager is
      // pinned separately below, where the age justifies it.
      expect(
        (reportSentryError as jest.Mock).mock.calls.length +
          (reportSentryMessage as jest.Mock).mock.calls.length,
      ).toBeGreaterThan(0);
      expect(
        (reportSentryError as jest.Mock).mock.calls.every(
          (c: unknown[]) => c[0] instanceof Error,
        ),
      ).toBe(true);
    }

    // The pager rung, pinned on its own: only an age past the page threshold
    // earns a page, and the warn rung must not page.
    jest.clearAllMocks();
    seed({
      consultantParks: [ceRow("ce2", "orgA", 12_000, daysAgo(5))],
      orgParks: [],
      verifiedOrgIds: [],
      paidOrgIds: [],
      releasedOrgCount: 0,
      releasedConsultantCount: 0,
    });
    await runReleasePendingTrustEarnings();
    expect(reportSentryError).toHaveBeenCalled();

    jest.clearAllMocks();
    seed({
      consultantParks: [ceRow("ce3", "orgA", 12_000, hoursAgo(25))],
      orgParks: [],
      verifiedOrgIds: [],
      paidOrgIds: [],
      releasedOrgCount: 0,
      releasedConsultantCount: 0,
    });
    await runReleasePendingTrustEarnings();
    // 25h is past the warn threshold and well short of the page threshold.
    expect(reportSentryMessage).toHaveBeenCalled();
    expect(reportSentryError).not.toHaveBeenCalled();
  });

  it("keeps the earning withheld from totals while parked", async () => {
    // The reason this needs a watchdog: earnings-service excludes PENDING_TRUST
    // from EarningsSummary.totalEarnings, so a stalled park is invisible money.
    // The watchdog is the only thing standing between that and silence.
    seed({ consultantParks: [ceRow("ce1", "orgA", 12_000, daysAgo(2))] });
    const r = await runReleasePendingTrustEarnings();
    expect(r.stalledPaise).toBe(12_000);
    expect(r.released).toBe(0);
  });
});
