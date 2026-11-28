/**
 * @jest-environment node
 */

/**
 * A sale is split among the team that was on the plan at one instant: a seat's
 * capture, or for a replay the start of the recorded session. These cases run
 * the real earnings service, fee module, split and team reader over in-memory
 * tables that honour each query's `where`.
 */

jest.mock("server-only", () => ({}));
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));
jest.mock("../../lib/feature-flags", () => ({ ENABLE_HOST_ORGS: true }));
const mockRecordSystemEvent = jest.fn();
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemErrorSafe: jest.fn(),
  recordSystemEvent: (...a: unknown[]) => mockRecordSystemEvent(...a),
}));
jest.mock("../../lib/payments/ledger/unapplied-receipts", () => ({
  hasUnappliedReceipt: jest.fn(async () => false),
  postUnappliedReceipt: jest.fn(),
}));
jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: (fn: () => Promise<unknown>) => fn(),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  LONG_JOB_TTL_MS: 1,
  withCronLock: (_name: string, _opts: unknown, fn: () => Promise<unknown>) =>
    fn(),
}));
const mockPostLedgerTxn = jest.fn(async (_tx: unknown, _input: unknown) => ({
  id: "journal-1",
}));
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: (tx: unknown, input: unknown) => mockPostLedgerTxn(tx, input),
}));
jest.mock("../../lib/payments/payouts/earnings-hold", () => ({
  computeHoldUntil: jest.fn(() => new Date("2026-12-01T00:00:00Z")),
  holdHoursFor: jest.fn(() => 24),
  withNewExpertHold: jest.fn(
    async (_db: unknown, _id: unknown, at: unknown) => at,
  ),
  lastLiveOccurrenceEnd: jest.fn(async () => null),
}));
jest.mock("../../lib/payments/billing/consumer-invoice", () => ({
  mintConsumerInvoiceBestEffort: jest.fn(),
}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import prisma from "@/lib/prisma";
import {
  createEarningsFromPayment,
  planEarningsForPayment,
  resolvePaymentForEarnings,
} from "@/lib/payments/payouts/earnings-service";
import type { Posting } from "@/lib/payments/ledger/post";
import { handleRecordingPurchaseSuccess } from "@/lib/payments/webhooks/recording-purchase";
import { syncPaymentEarnings } from "@/scripts/earnings/sync-payment-earnings";
import { matchesWhere, memTable, type Row } from "../fixtures/mem-db";

// A ₹10,000 class seat; the collaborator holds 20% and the order is stamped at a 20% platform fee.
const SEAT = 1_000_000;
const CHECKOUT = new Date("2026-03-09T09:00:00Z");
const ACCEPTED = new Date("2026-03-09T12:00:00Z");
const CAPTURED = new Date("2026-03-10T09:00:00Z");
const REMOVED = new Date("2026-03-20T09:00:00Z");

function collaborator(over: Row): Row {
  const endedAt = (over.endedAt as Date | undefined) ?? null;
  const consultantProfileId = String(over.consultantProfileId ?? "cp-collab");
  return {
    id: `collab-${consultantProfileId}`,
    consultantProfileId,
    classPlanId: "plan-1",
    webinarPlanId: null,
    role: "CO_INSTRUCTOR",
    tier: "STANDARD",
    revenueShareBps: 2000,
    acceptedAt: ACCEPTED,
    status: endedAt ? "REMOVED" : "ACCEPTED",
    consultantProfile: { userId: `u-${consultantProfileId}`, deletedAt: null },
    ...over,
    endedAt,
  };
}

/** A captured seat as the payment table holds it, with the relations the earnings readers join. */
function seatPayment(over: Row = {}): Row {
  return {
    id: "pay-seat",
    userId: "u-buyer",
    amount: SEAT,
    originalAmount: SEAT,
    taxAmount: 0,
    currency: "INR",
    paymentStatus: "SUCCEEDED",
    isMockPayment: false,
    platformFeeBps: 2000,
    attributionSource: "MARKETPLACE",
    organizationId: null,
    billingAccountId: null,
    description: null,
    createdAt: CHECKOUT,
    capturedAt: CAPTURED,
    appointmentId: "appt-seat",
    earnings: [],
    organizationEarnings: [],
    refunds: [],
    disputes: [],
    appointment: {
      id: "appt-seat",
      appointmentType: "CLASS",
      organizationId: null,
      consultation: null,
      subscription: null,
      webinar: null,
      trial: null,
      class: {
        id: "class-1",
        classPlanId: "plan-1",
        classPlan: {
          id: "plan-1",
          consultantProfileId: "cp-host",
          organizationId: null,
          consultantProfile: { id: "cp-host" },
        },
      },
    },
    ...over,
  };
}

/** Returns only what a nested Prisma `select` asks for, as the database would. */
function project(row: unknown, select: Row): unknown {
  if (row === null || row === undefined) return row;
  return Object.fromEntries(
    Object.entries(select).map(([key, sub]) => {
      const value = (row as Row)[key];
      return [
        key,
        sub && typeof sub === "object" && "select" in sub
          ? project(value, sub.select as Row)
          : value,
      ];
    }),
  );
}

function makeDb(
  seed: {
    collaborators?: Row[];
    plans?: Row[];
    payments?: Row[];
    purchases?: Row[];
    rateCard?: Row | null;
  } = {},
) {
  const plans = memTable(
    seed.plans ?? [
      { id: "plan-1", consultantProfileId: "cp-host", organizationId: null },
    ],
  );
  const payments = memTable(seed.payments ?? [], "pay");
  const purchases = memTable(seed.purchases ?? []);
  const db = {
    collaborator: memTable(seed.collaborators ?? []),
    classPlan: plans,
    webinarPlan: plans,
    consultantEarnings: memTable([], "ce"),
    organizationEarnings: memTable([], "oe"),
    payment: {
      ...payments,
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = {
          id: `pay-${payments.rows.length + 1}`,
          platformFeeBps: null,
          attributionSource: null,
          billingAccountId: null,
          createdAt: new Date(),
          ...data,
        };
        payments.rows.push(row);
        return { ...row };
      }),
      count: jest.fn(
        async ({ where }: { where: Row }) =>
          payments.rows.filter((r) => matchesWhere(r, where)).length,
      ),
    },
    recordingPurchase: {
      ...purchases,
      findUnique: jest.fn(
        async ({ where, select }: { where: Row; select: Row }) =>
          project(
            purchases.rows.find((r) => matchesWhere(r, where)) ?? null,
            select,
          ),
      ),
    },
    paymentLeg: memTable([]),
    membership: memTable([]),
    supportCase: memTable([]),
    overageEvent: { updateMany: jest.fn(async () => ({ count: 0 })) },
    expertCustomerRelationship: memTable([]),
    platformFeeSchedule: memTable([]),
    consultantFeeWaiver: memTable([]),
    systemEvent: memTable([]),
    contract: { findFirst: jest.fn(async () => null) },
    rateCard: { findFirst: jest.fn(async () => seed.rateCard ?? null) },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  return db;
}
type Db = ReturnType<typeof makeDb>;

/** Points the global client at `db`, for the paths that open their own transaction. */
function useAsGlobalClient(db: Db) {
  const client = prisma as unknown as Row;
  for (const key of Object.keys(client)) delete client[key];
  Object.assign(client, db);
}

/** Settles the seat through the reader the capture paths use, splitting as of `teamAt`. */
async function settleSeat(
  tx: Db,
  teamAt: Date,
  preplanned?: Awaited<ReturnType<typeof planEarningsForPayment>>,
) {
  const resolved = await resolvePaymentForEarnings(
    { id: "pay-seat" },
    "CLASS",
    tx as never,
  );
  if (!resolved) throw new Error("the seat payment did not resolve");
  await createEarningsFromPayment({
    payment: resolved.paymentForEarnings,
    appointmentType: resolved.earningsAppointmentType,
    tx: tx as never,
    teamAt,
    preplanned,
  });
}

/** Net paise each expert was credited, by profile. */
function netByExpert(db: Db): Record<string, number> {
  return Object.fromEntries(
    db.consultantEarnings.rows.map((r) => [
      r.consultantProfileId,
      r.consultantSharePaise,
    ]),
  );
}

/** The platform's take on the one journal posted, after checking it balances. */
function platformTake(): number {
  const { postings } = mockPostLedgerTxn.mock.calls[0][1] as {
    postings: Posting[];
  };
  const total = (direction: Posting["direction"]) =>
    postings
      .filter((p) => p.direction === direction)
      .reduce((sum, p) => sum + p.amountPaise, 0);
  if (total("DEBIT") !== total("CREDIT")) {
    throw new Error("the booking journal does not balance");
  }
  return postings
    .filter((p) => p.account.kind === "PLATFORM_FEE")
    .reduce((sum, p) => sum + p.amountPaise, 0);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("a seat is split among the team as of its capture", () => {
  it("pays the host ₹6,400, the collaborator ₹1,600 and the platform ₹2,000", async () => {
    const db = makeDb({
      collaborators: [collaborator({})],
      payments: [seatPayment()],
    });

    await settleSeat(db, CAPTURED);

    expect(netByExpert(db)).toEqual({
      "cp-host": 640_000,
      "cp-collab": 160_000,
    });
    expect(platformTake()).toBe(200_000);
  });

  it("splits the same way once the collaborator has been removed", async () => {
    const db = makeDb({
      collaborators: [collaborator({ endedAt: REMOVED })],
      payments: [seatPayment()],
    });

    await settleSeat(db, CAPTURED);

    expect(netByExpert(db)).toEqual({
      "cp-host": 640_000,
      "cp-collab": 160_000,
    });
    expect(platformTake()).toBe(200_000);
  });

  it("gives a removed collaborator nothing from a seat captured afterwards", async () => {
    const db = makeDb({
      collaborators: [collaborator({ endedAt: REMOVED })],
      payments: [seatPayment()],
    });

    await settleSeat(db, new Date(REMOVED.getTime() + 1));

    expect(netByExpert(db)).toEqual({ "cp-host": 800_000 });
    expect(platformTake()).toBe(200_000);
  });

  it("gives a collaborator who accepts later nothing from a seat already captured", async () => {
    const db = makeDb({
      collaborators: [collaborator({ acceptedAt: REMOVED })],
      payments: [seatPayment()],
    });

    await settleSeat(db, CAPTURED);

    expect(netByExpert(db)).toEqual({ "cp-host": 800_000 });
  });

  it("gives an erased collaborator no slice; the host keeps the remainder", async () => {
    const db = makeDb({
      collaborators: [
        collaborator({
          consultantProfile: { userId: "u-cp-collab", deletedAt: REMOVED },
        }),
      ],
      payments: [seatPayment()],
    });

    await settleSeat(db, CAPTURED);

    expect(netByExpert(db)).toEqual({ "cp-host": 800_000 });
  });
});

describe("a capture decides its split inside its own transaction", () => {
  const PLANNED = new Date(CAPTURED.getTime() - 2_000);
  const BETWEEN = new Date(CAPTURED.getTime() - 1_000);

  it("does not pay a collaborator removed between the pre-plan and the capture", async () => {
    const before = makeDb({
      collaborators: [collaborator({})],
      payments: [seatPayment()],
    });
    const preplanned = await planEarningsForPayment(
      { id: "pay-seat" },
      PLANNED,
      "CLASS",
      before as never,
    );
    expect(preplanned?.splits.map((s) => s.share)).toEqual([800_000, 200_000]);

    const tx = makeDb({
      collaborators: [collaborator({ endedAt: BETWEEN })],
      payments: [seatPayment()],
    });
    await settleSeat(tx, CAPTURED, preplanned);

    expect(tx.collaborator.findMany).toHaveBeenCalledTimes(1);
    expect(netByExpert(tx)).toEqual({ "cp-host": 800_000 });
    expect(platformTake()).toBe(200_000);
  });

  it("pays a collaborator who accepted between the pre-plan and the capture", async () => {
    const before = makeDb({ payments: [seatPayment()] });
    const preplanned = await planEarningsForPayment(
      { id: "pay-seat" },
      PLANNED,
      "CLASS",
      before as never,
    );
    expect(preplanned?.splits).toEqual([]);

    const tx = makeDb({
      collaborators: [collaborator({ acceptedAt: BETWEEN })],
      payments: [seatPayment()],
    });
    await settleSeat(tx, CAPTURED, preplanned);

    expect(netByExpert(tx)).toEqual({
      "cp-host": 640_000,
      "cp-collab": 160_000,
    });
    expect(platformTake()).toBe(200_000);
  });

  it("reuses a pre-plan that saw the same team, adding only the team read", async () => {
    const before = makeDb({
      collaborators: [collaborator({})],
      payments: [seatPayment()],
    });
    const preplanned = await planEarningsForPayment(
      { id: "pay-seat" },
      PLANNED,
      "CLASS",
      before as never,
    );

    const tx = makeDb({
      collaborators: [collaborator({})],
      payments: [seatPayment()],
    });
    await settleSeat(tx, CAPTURED, preplanned);

    expect(tx.collaborator.findMany).toHaveBeenCalledTimes(1);
    expect(tx.membership.findFirst).not.toHaveBeenCalled();
    expect(netByExpert(tx)).toEqual({
      "cp-host": 640_000,
      "cp-collab": 160_000,
    });
  });
});

describe("the earnings sweep settles what the first attempt would have", () => {
  it.each([
    ["its capture time", { capturedAt: CAPTURED }],
    [
      "its creation time when no capture time was stamped",
      { capturedAt: null, createdAt: CAPTURED },
    ],
  ])(
    "splits a deferred seat by %s, after the collaborator was removed",
    async (_label, times) => {
      const db = makeDb({
        collaborators: [collaborator({ endedAt: REMOVED })],
        payments: [seatPayment(times)],
      });
      useAsGlobalClient(db);

      const result = await syncPaymentEarnings();

      expect(result).toMatchObject({ createdCount: 1, errorCount: 0 });
      expect(netByExpert(db)).toEqual({
        "cp-host": 640_000,
        "cp-collab": 160_000,
      });
    },
  );

  const ORG_PLAN = {
    id: "plan-org",
    consultantProfileId: null,
    organizationId: "org-1",
  };
  const orgSeat = (over: Row = {}) =>
    seatPayment({
      appointment: {
        id: "appt-seat",
        appointmentType: "WEBINAR",
        organizationId: null,
        consultation: null,
        subscription: null,
        class: null,
        trial: null,
        webinar: {
          id: "webinar-1",
          webinarPlanId: "plan-org",
          webinarPlan: { ...ORG_PLAN, consultantProfile: null },
        },
      },
      ...over,
    });

  it("settles a seat on a plan an organisation owns, and pages nobody", async () => {
    const db = makeDb({
      plans: [ORG_PLAN],
      payments: [orgSeat()],
      rateCard: {
        id: "rc-1",
        platformBps: 1000,
        orgBps: 9000,
        consultantBps: 0,
      },
    });
    useAsGlobalClient(db);

    const result = await syncPaymentEarnings();

    expect(result).toMatchObject({
      createdCount: 1,
      errorCount: 0,
      pagedCount: 0,
    });
    expect(db.organizationEarnings.rows).toEqual([
      expect.objectContaining({
        organizationId: "org-1",
        role: "OWNER",
        grossAmountPaise: SEAT,
        platformFeePaise: 100_000,
        orgSharePaise: 900_000,
      }),
    ]);
    expect(mockRecordSystemEvent).not.toHaveBeenCalled();
  });

  it("leaves a seat already settled to its organisation out of the run", async () => {
    const db = makeDb({
      plans: [ORG_PLAN],
      payments: [orgSeat({ organizationEarnings: [{ id: "oe-settled" }] })],
    });
    useAsGlobalClient(db);

    const result = await syncPaymentEarnings();

    expect(result).toMatchObject({ totalProcessed: 0, pagedCount: 0 });
    expect(mockRecordSystemEvent).not.toHaveBeenCalled();
  });
});

describe("a replay is split among the team as of the recorded session", () => {
  const SESSION = new Date("2026-03-15T09:00:00Z");

  it("pays the co-host who presented, not the one who joined afterwards", async () => {
    const onWebinar = { classPlanId: null, webinarPlanId: "plan-1" };
    const db = makeDb({
      collaborators: [
        collaborator({
          ...onWebinar,
          consultantProfileId: "cp-presenter",
          revenueShareBps: 2500,
          endedAt: REMOVED,
        }),
        collaborator({
          ...onWebinar,
          consultantProfileId: "cp-newcomer",
          revenueShareBps: 2500,
          acceptedAt: new Date(REMOVED.getTime() + 1),
        }),
      ],
      purchases: [
        {
          id: "rp-1",
          gatewayOrderId: "order_replay",
          recordingId: "rec-1",
          buyerId: "u-buyer",
          amountPaise: BigInt(50_000),
          status: "PENDING",
          gatewayPaymentId: null,
          recording: {
            id: "rec-1",
            organizationId: null,
            listingStatus: "PUBLISHED",
            status: "READY",
            storageType: "SUPABASE",
            meeting: {
              occurrence: {
                startsAt: SESSION,
                appointment: {
                  organizationId: null,
                  class: null,
                  consultation: null,
                  subscription: null,
                  webinar: {
                    webinarPlanId: "plan-1",
                    webinarPlan: {
                      id: "plan-1",
                      consultantProfileId: "cp-host",
                      organizationId: null,
                      visibility: "PUBLIC",
                    },
                  },
                },
              },
            },
          },
        },
      ],
    });
    useAsGlobalClient(db);

    // A ₹500 replay sold after the presenter left; both parties pay the 20% marketplace fee.
    await handleRecordingPurchaseSuccess("order_replay", "pay_gw", {}, 50_000);

    expect(netByExpert(db)).toEqual({
      "cp-host": 30_000,
      "cp-presenter": 10_000,
    });
    expect(platformTake()).toBe(10_000);
  });
});
