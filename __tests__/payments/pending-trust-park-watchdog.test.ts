/**
 * @jest-environment node
 */

/**
 * #687 E-01/E-02 — the PENDING_TRUST park watchdog (a reconcile-ledgers
 * finding). Pins the per-sponsor grouping, and that the release job is
 * condition-driven only: no age ever releases a park.
 */

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
  default: {
    consultantEarnings: {},
    organizationEarnings: {},
    organization: {},
    organizationInvoice: {},
    $disconnect: jest.fn(),
  },
}));

import prisma from "../../lib/prisma";
import {
  groupPendingTrustParks,
  PENDING_TRUST_PARK_STALE_MS,
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

// Prisma hands back BigInt for the money columns.
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
    // The release pass narrows by unlocked sponsor.
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

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
  jest.clearAllMocks();
});

afterEach(() => jest.useRealTimers());

// --- 1. detection -------------------------------------------------------

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
      // The rows are un-parkable, so the CAS is never even attempted.
      expect(db.consultantEarnings.updateMany).not.toHaveBeenCalled();
      expect(db.organizationEarnings.updateMany).not.toHaveBeenCalled();
    }
  });
});
