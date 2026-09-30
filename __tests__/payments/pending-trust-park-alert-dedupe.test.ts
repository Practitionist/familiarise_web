/**
 * @jest-environment node
 */

/**
 * #687 E-01/E-02 — the PENDING_TRUST park watchdog, operational defects.
 *
 * `pending-trust-park-watchdog.test.ts` pins what the watchdog must DO (grade
 * the age, escalate, never release on age). This file pins the two things that
 * made it unusable in production, which are properties of the alerting itself
 * rather than of the grading:
 *
 *   1. A STALL ALERT FIRES ONCE PER RUNG, NOT ONCE PER RUN. The cadence sets
 *      the interval, not the count. A sponsor that is never verified and never
 *      pays an invoice is still past 72h on every run from day three onward, so
 *      without a dedupe the hourly job paged 24×/day forever. That is how an
 *      alert gets muted — and the next real incident is muted with it. The
 *      dedupe is durable (a `SystemEvent` row read back before alerting), which
 *      is the only kind that works in a serverless job: a module-level Set
 *      resets on every cold start and would re-page the moment a new lambda
 *      spins up, which on an hourly cron is most of them.
 *
 *   2. THE WATCHDOG CANNOT BLOCK THE RELEASE. It runs before the
 *      `unlockedOrgIds.length === 0` short-circuit (that short-circuit IS the
 *      stalled case), so an unisolated watchdog fault — bad query, null deref,
 *      failing Sentry client — aborts the run before the release step and
 *      genuinely releasable money stops being released. A detector that can veto
 *      the thing it observes is not a detector.
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

// The job logs through `Sentry.logger.*` and reports the watchdog's own fault
// with `captureException`; both need to be observable, and a throwing
// observability client is one of the faults the isolation has to survive.
jest.mock("@sentry/nextjs", () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  // Shape only — `seed()` fills the delegates in before each run. Built inside
  // the factory because jest hoists `jest.mock` above the module imports, so a
  // factory closing over a module-scope const would hit the TDZ.
  default: {
    consultantEarnings: {},
    organizationEarnings: {},
    organization: {},
    organizationInvoice: {},
    systemEvent: {},
    $disconnect: jest.fn(),
  },
}));

import prisma from "../../lib/prisma";
import * as Sentry from "@sentry/nextjs";
import { recordSystemEventSafe } from "../../lib/enterprise/system-events";
import {
  reportSentryError,
  reportSentryMessage,
} from "../../lib/observability/report";
import { runReleasePendingTrustEarnings } from "../../jobs/cleanup/release-pending-trust-earnings";

const db = prisma as unknown as {
  consultantEarnings: { findMany: jest.Mock; updateMany: jest.Mock };
  organizationEarnings: { findMany: jest.Mock; updateMany: jest.Mock };
  organization: { findMany: jest.Mock };
  organizationInvoice: { findMany: jest.Mock };
  systemEvent: { findMany: jest.Mock; findFirst: jest.Mock };
};

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-09-30T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * HOUR);

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

/**
 * One already-raised escalation marker, as `readRaisedParkAlertsSafe` selects
 * it back. The `context` shape has to match the one the job WRITES, which is
 * the whole contract: the read key and the write key are the same constant.
 */
const marker = (organizationId: string, rung: "WARN" | "ERROR") => ({
  organizationId,
  context: { parkAlertRung: rung },
});

/** The slice of the `where` clause the dedupe read builds that the mock reads. */
type MarkerQuery = {
  where?: {
    organizationId?: { in?: string[] };
    category?: string;
    OR?: { context?: { path?: string[]; equals?: unknown } }[];
  };
};

/**
 * `systemEvent.findMany` mock that evaluates the real `where` clause the job
 * builds — org filter, category, and the OR'd JSON-path rung predicates. Not a
 * blanket `return markers`: if the job's query were wrong (wrong key, wrong
 * path, missing org scope), a permissive mock would hide exactly the bug this
 * file exists to catch.
 */
function systemEventMock(raised: ReturnType<typeof marker>[]) {
  return jest.fn(async (q: MarkerQuery) => {
    const orgs = q?.where?.organizationId?.in ?? [];
    const category = q?.where?.category;
    return raised.filter(
      (m) =>
        orgs.includes(m.organizationId) &&
        (category === undefined || category === "PAYOUT") &&
        (q?.where?.OR ?? []).some((clause) => {
          const key = clause?.context?.path?.[0];
          return (
            key === "parkAlertRung" &&
            clause?.context?.equals === m.context.parkAlertRung
          );
        }),
    );
  });
}

function seed(args: {
  consultantParks?: ReturnType<typeof ceRow>[];
  orgParks?: ReturnType<typeof oeRow>[];
  verifiedOrgIds?: string[];
  paidOrgIds?: string[];
  releasedOrgCount?: number;
  releasedConsultantCount?: number;
  /** Pre-existing escalation markers — what a previous hourly run left behind. */
  raised?: ReturnType<typeof marker>[];
  /** Make the parked-row READ itself throw, to fault the watchdog. */
  parkedReadThrows?: boolean;
}) {
  const {
    consultantParks = [],
    orgParks = [],
    verifiedOrgIds = [],
    paidOrgIds = [],
    releasedOrgCount = 0,
    releasedConsultantCount = 0,
    raised = [],
    parkedReadThrows = false,
  } = args;

  if (parkedReadThrows) {
    const boom = async () => {
      throw new Error("P1001 connection pool timeout");
    };
    db.consultantEarnings = {
      findMany: boom,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateMany: jest.fn(async (..._a: any[]): Promise<any> => ({ count: 0 })),
    };
    db.organizationEarnings = {
      findMany: boom,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateMany: jest.fn(async (..._a: any[]): Promise<any> => ({ count: 0 })),
    };
  } else {
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
  }

  db.organization = {
    findMany: jest.fn(async () => verifiedOrgIds.map((id) => ({ id }))),
  };
  db.organizationInvoice = {
    findMany: jest.fn(async () =>
      paidOrgIds.map((organizationId) => ({ organizationId })),
    ),
  };
  db.systemEvent = { findMany: systemEventMock(raised), findFirst: jest.fn() };
}

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
  jest.clearAllMocks();
  (recordSystemEventSafe as jest.Mock).mockResolvedValue(undefined);
});

afterEach(() => jest.useRealTimers());

// --- 1. a stalled sponsor pages once, not once per run ---------------------

describe("park alert dedupe — the page rung fires once per sponsor", () => {
  it("pages on the first run past the threshold and stays silent on the next", async () => {
    // Run 1: the sponsor has never been escalated. No markers exist.
    seed({
      consultantParks: [ceRow("ce1", "orgA", 12_000, daysAgo(4))],
      verifiedOrgIds: [],
      paidOrgIds: [],
    });

    const first = await runReleasePendingTrustEarnings();

    expect(first.pagedOrgs).toBe(1);
    expect(first.escalatedOrgs).toBe(1);
    expect(first.dedupedOrgs).toBe(0);
    expect(reportSentryError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ expected: false }),
    );
    // The marker carries the rung, under the same key the next run reads.
    expect(recordSystemEventSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "orgA",
        category: "PAYOUT",
        severity: "ERROR",
        context: expect.objectContaining({ parkAlertRung: "ERROR" }),
      }),
    );

    // Run 2: the same world, next hour. The row is still past 72h and still a
    // group in `stalled` — nothing about the age changed except that more of it
    // went by. The only reason it must not page again is the marker run 1 wrote.
    jest.clearAllMocks();
    seed({
      consultantParks: [ceRow("ce1", "orgA", 12_000, daysAgo(4))],
      verifiedOrgIds: [],
      paidOrgIds: [],
      raised: [marker("orgA", "ERROR")],
    });

    const second = await runReleasePendingTrustEarnings();

    expect(reportSentryError).not.toHaveBeenCalled();
    expect(recordSystemEventSafe).not.toHaveBeenCalled();
    expect(second.pagedOrgs).toBe(0);
    expect(second.dedupedOrgs).toBe(1);
    expect(second.escalatedOrgs).toBe(0);
    // THE PART THAT MATTERS: the stall is still detected and still reported as
    // money at risk. Only the ALERT is suppressed. A dedupe that also silenced
    // the finding would be the same alert-muting failure one level up.
    expect(second.stalledOrgs).toBe(1);
    expect(second.stalledPaise).toBe(12_000);
    expect(second.stillParked).toBe(1);
    expect(second.released).toBe(0);
  });

  it("stays silent across many further runs, so the page count is 1 not 24/day", async () => {
    seed({
      consultantParks: [ceRow("ce1", "orgA", 12_000, daysAgo(4))],
      raised: [marker("orgA", "ERROR")],
    });
    for (let i = 0; i < 25; i += 1) {
      const r = await runReleasePendingTrustEarnings();
      expect(r.pagedOrgs).toBe(0);
      expect(r.dedupedOrgs).toBe(1);
    }
    expect(reportSentryError).not.toHaveBeenCalled();
    expect(reportSentryMessage).not.toHaveBeenCalled();
  });

  it("dedupes per SPONSOR, so one stalled org never mutes another", async () => {
    // The dangerous shape of a dedupe is a global flag: orgB pages exactly once
    // because orgA already paged. Keys are (organizationId, rung), so this
    // cannot happen.
    seed({
      consultantParks: [
        ceRow("ce1", "orgA", 12_000, daysAgo(4)),
        ceRow("ce2", "orgB", 30_000, daysAgo(6)),
      ],
      raised: [marker("orgA", "ERROR")],
    });

    const r = await runReleasePendingTrustEarnings();

    expect(r.pagedOrgs).toBe(1);
    expect(r.escalatedOrgs).toBe(1);
    expect(r.dedupedOrgs).toBe(1);
    // orgB is the one that paged.
    expect(reportSentryError).toHaveBeenCalledTimes(1);
    expect(
      (recordSystemEventSafe as jest.Mock).mock.calls[0][0].organizationId,
    ).toBe("orgB");
  });
});

// --- 2. the ladder escalates each rung exactly once ------------------------

describe("park alert dedupe — the warn→page ladder climbs through both rungs", () => {
  it("warns once at 30h, then pages once at 96h, and never repeats a rung", async () => {
    // --- rung 1: WARN. 30h old, nothing raised yet.
    seed({
      consultantParks: [ceRow("ce1", "orgA", 12_000, daysAgo(1.25))],
      raised: [],
    });
    const warned = await runReleasePendingTrustEarnings();

    expect(warned.escalatedOrgs).toBe(1);
    expect(warned.dedupedOrgs).toBe(0);
    expect(warned.pagedOrgs).toBe(0);
    // WARN rung: findable, but not an incident.
    expect(reportSentryMessage).toHaveBeenCalledTimes(1);
    expect(reportSentryError).not.toHaveBeenCalled();
    expect(recordSystemEventSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "WARN",
        context: expect.objectContaining({ parkAlertRung: "WARN" }),
      }),
    );

    // --- same rung, next hour. Silent.
    jest.clearAllMocks();
    seed({
      consultantParks: [ceRow("ce1", "orgA", 12_000, daysAgo(1.25))],
      raised: [marker("orgA", "WARN")],
    });
    const warnedAgain = await runReleasePendingTrustEarnings();
    expect(warnedAgain.dedupedOrgs).toBe(1);
    expect(reportSentryMessage).not.toHaveBeenCalled();
    expect(reportSentryError).not.toHaveBeenCalled();

    // --- rung 2: the park crosses 72h. The WARN marker must NOT suppress the
    // page — the rungs are independent keys, which is what makes this a ladder
    // rather than a one-shot.
    jest.clearAllMocks();
    seed({
      consultantParks: [ceRow("ce1", "orgA", 12_000, daysAgo(4))],
      raised: [marker("orgA", "WARN")],
    });
    const paged = await runReleasePendingTrustEarnings();

    expect(paged.pagedOrgs).toBe(1);
    expect(paged.escalatedOrgs).toBe(1);
    expect(paged.dedupedOrgs).toBe(0);
    expect(reportSentryError).toHaveBeenCalledTimes(1);
    expect(recordSystemEventSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "ERROR",
        context: expect.objectContaining({ parkAlertRung: "ERROR" }),
      }),
    );

    // --- page rung, next hour. Silent. Both markers now exist.
    jest.clearAllMocks();
    seed({
      consultantParks: [ceRow("ce1", "orgA", 12_000, daysAgo(4))],
      raised: [marker("orgA", "WARN"), marker("orgA", "ERROR")],
    });
    const pagedAgain = await runReleasePendingTrustEarnings();
    expect(pagedAgain.dedupedOrgs).toBe(1);
    expect(reportSentryError).not.toHaveBeenCalled();
    expect(recordSystemEventSafe).not.toHaveBeenCalled();
    // Exactly one WARN row and one ERROR row were ever written for this
    // sponsor across the whole ladder — the ladder climbed once, not hourly.
    expect(pagedAgain.escalatedOrgs).toBe(0);
    expect(pagedAgain.stalledOrgs).toBe(1);
  });

  it("does not let a stale WARN marker suppress a page for a DIFFERENT org", async () => {
    seed({
      consultantParks: [ceRow("ce1", "orgA", 12_000, daysAgo(4))],
      raised: [marker("orgB", "WARN")],
    });
    const r = await runReleasePendingTrustEarnings();
    expect(r.pagedOrgs).toBe(1);
    expect(reportSentryError).toHaveBeenCalledTimes(1);
  });
});

// --- 3. a broken watchdog must not block a legitimate release --------------

describe("the watchdog is isolated from the release", () => {
  it("still releases when the watchdog's own read throws", async () => {
    // The watchdog's snapshot query blows up (pool exhaustion, bad predicate).
    // Before the fix this propagated out of `auditStalledParks` and the run
    // never reached the release step, so a healthy sponsor's money sat in
    // PENDING_TRUST indefinitely because a DETECTION query was broken.
    //
    // The two read the same delegate, so the fault is call-indexed: the first
    // call is the watchdog's snapshot and throws, the second is the release
    // scan and succeeds. That is the sharper version of the bug — the failure
    // is specific to the watchdog, and the release it was blocking is
    // perfectly healthy.
    let orgFindManyCalls = 0;
    db.organizationEarnings = {
      findMany: jest.fn(async () => {
        orgFindManyCalls += 1;
        if (orgFindManyCalls === 1) {
          throw new Error("P1001 watchdog snapshot failed");
        }
        return [];
      }),
      updateMany: jest.fn(async () => ({ count: 0 })),
    };
    db.consultantEarnings = {
      findMany: jest.fn(async () => [ceRow("ce1", "orgA", 12_000, daysAgo(0.5))]),
      updateMany: jest.fn(async () => ({ count: 1 })),
    };
    db.organization = { findMany: jest.fn(async () => [{ id: "orgA" }]) };
    db.organizationInvoice = { findMany: jest.fn(async () => []) };
    db.systemEvent = { findMany: systemEventMock([]), findFirst: jest.fn() };

    const r = await runReleasePendingTrustEarnings();

    // Reported, loudly and durably.
    expect(r.watchdogFailed).toBe(true);
    expect(r.errors.some((e) => e.includes("watchdog"))).toBe(true);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ job: "release-pending-trust-earnings" }),
      }),
    );

    // AND the thing the watchdog was observing still happened.
    expect(r.released).toBe(1);
    expect(r.scanned).toBe(1);
    expect(db.consultantEarnings.updateMany).toHaveBeenCalled();
  });

  it("still releases when the Sentry client itself throws inside the watchdog", async () => {
    // The other fault class in the brief, and the one least likely to be caught
    // by a query-level guard: the observability client raises mid-alert. The
    // watchdog is mid-escalation here (a WARN-age park), and orgA is ALSO
    // verified, so there is a legitimate release riding on the same run.
    // `Once` so the throwing client cannot leak into the later tests.
    (Sentry.captureMessage as jest.Mock).mockImplementationOnce(() => {
      throw new Error("sentry transport exploded");
    });
    seed({
      consultantParks: [ceRow("ce1", "orgA", 12_000, daysAgo(1.25))],
      verifiedOrgIds: ["orgA"],
      releasedConsultantCount: 1,
    });

    const r = await runReleasePendingTrustEarnings();

    expect(r.watchdogFailed).toBe(true);
    expect(r.errors.some((e) => e.includes("watchdog"))).toBe(true);
    // The release ran, and it is the only thing that moved money.
    expect(r.released).toBe(1);
    expect(r.scanned).toBe(1);
  });

  it("leaves the parked counts explicitly UNKNOWN rather than reading as a clean run", async () => {
    // `stillParked: 0` when the watchdog threw means UNKNOWN, not zero, and
    // the flag is how a reader tells them apart. Without it, a broken watchdog
    // reads as a healthy clean run — the worst possible failure mode for a
    // watchdog, because it is indistinguishable from the thing it exists to
    // contradict.
    seed({
      consultantParks: [],
      orgParks: [],
      verifiedOrgIds: [],
      paidOrgIds: [],
      parkedReadThrows: true,
    });

    const r = await runReleasePendingTrustEarnings();

    expect(r.watchdogFailed).toBe(true);
    expect(r.stalledOrgs).toBe(0);
    expect(r.stillParked).toBe(0);
    expect(r.errors.length).toBeGreaterThan(0);
    // No release candidates could be found either (the read threw), but the
    // run still returned a result rather than propagating.
    expect(r.released).toBe(0);
  });
});

// --- 4. an unlocked sponsor releases and stops being alerted ----------------

describe("a sponsor that unblocks is released and goes quiet", () => {
  it("releases its rows and raises nothing, even with a page marker on file", async () => {
    // The recovery path. The sponsor gets verified; its rows leave
    // PENDING_TRUST; so it is no longer in `readParkedRows`, is no longer a
    // group, and is not alerted. The stale marker row stays as audit history
    // and is harmless — it is only ever READ for orgs that are still parked.
    seed({
      consultantParks: [ceRow("ce1", "orgA", 12_000, daysAgo(0.5))],
      orgParks: [oeRow("oe1", "orgA", 4_000, daysAgo(0.5))],
      verifiedOrgIds: ["orgA"],
      releasedOrgCount: 1,
      releasedConsultantCount: 1,
      raised: [marker("orgA", "ERROR")],
    });

    const r = await runReleasePendingTrustEarnings();

    expect(r.released).toBe(2);
    expect(r.scanned).toBe(2);
    expect(r.stillParked).toBe(0);
    expect(r.stalledOrgs).toBe(0);
    expect(r.pagedOrgs).toBe(0);
    expect(r.escalatedOrgs).toBe(0);
    expect(reportSentryError).not.toHaveBeenCalled();
    expect(reportSentryMessage).not.toHaveBeenCalled();
    expect(recordSystemEventSafe).not.toHaveBeenCalled();
  });

  it("keeps alerting and never releasing for a sponsor that stays locked", async () => {
    // The two halves of the anti-fraud guard, held together: detection is
    // loud and persistent, release is still condition-driven only. The marker
    // stops the PAGE repeating; nothing about it releases a single paise.
    seed({
      consultantParks: [ceRow("ce1", "orgA", 12_000, daysAgo(5))],
      verifiedOrgIds: [],
      paidOrgIds: [],
      raised: [marker("orgA", "ERROR")],
    });

    const r = await runReleasePendingTrustEarnings();

    expect(r.released).toBe(0);
    expect(db.consultantEarnings.updateMany).not.toHaveBeenCalled();
    expect(r.stalledOrgs).toBe(1);
    expect(r.stalledPaise).toBe(12_000);
    expect(r.watchdogFailed).toBe(false);
  });
});

// --- 5. the dedupe read itself fails open ----------------------------------

describe("dedupe read failure", () => {
  it("alerts rather than suppressing, so a broken read cannot hide a stall", async () => {
    // The two failure modes of a read-then-write dedupe are not symmetric.
    // Suppressing on a failed read would silence a real 72h+ withholding stall
    // — the single thing this watchdog exists to prevent — so a failed read
    // escalates. The cost is a duplicate page during a database blip that is
    // itself reported, which is recoverable and bounded by the blip.
    seed({
      consultantParks: [ceRow("ce1", "orgA", 12_000, daysAgo(4))],
    });
    db.systemEvent = {
      findMany: jest.fn(async () => {
        throw new Error("system_events unavailable");
      }),
      findFirst: jest.fn(),
    };

    const r = await runReleasePendingTrustEarnings();

    expect(r.pagedOrgs).toBe(1);
    expect(reportSentryError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ expected: false }),
    );
    expect(recordSystemEventSafe).toHaveBeenCalled();
    // The degradation is logged, but it does NOT escalate to a page of its
    // own: paging about a failed de-duplication read would be the tail wagging
    // the dog, and it would add a second page to the one already being sent.
    expect(Sentry.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("dedupe read failed"),
      expect.objectContaining({ failingOpen: true }),
    );
    expect(
      (reportSentryError as jest.Mock).mock.calls.filter(
        (c: unknown[]) =>
          (c[1] as { op?: string } | undefined)?.op ===
          "pending-trust-park-dedupe-read",
      ),
    ).toHaveLength(0);
  });
});
