/**
 * @jest-environment node
 */

/**
 * A CREDIT_POOL subscription meters every allocation batch per session, each
 * over-cap batch carries its own OverageEvent, and a re-bought seat's refund
 * reverses only that sale. Runs the real metering, settlement and reversal
 * code against an in-memory stand-in for the rows they touch.
 */

import { recordSubscriptionAllocationCap } from "@/lib/booking/allocation/commit/subscription-cap";
import { reverseBookingUtilization } from "@/lib/api/organizations/program-helpers";
import { txDouble } from "../fixtures/tx-double";
import { createEarningsHoldStore } from "../fixtures/earnings-hold-store";

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgProgramOverageDue: jest.fn(),
}));
jest.mock("../../lib/api/organizations/wallet", () => ({
  walletDebit: jest.fn(),
  walletCredit: jest.fn(),
}));
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: jest.fn(),
}));

type Step = { increment?: number; decrement?: number };
type Range = { lte?: number; gte?: number; lt?: number };
type Meter = {
  engagementsUsed: number;
  consumedPaise: number;
  overageCount: number;
};
type LedgerRow = {
  id: string;
  paymentId: string;
  engagementsConsumed: number;
  priceAtBookingPaise: number;
  wasOverage: boolean;
  createdAt: Date;
};
type Event = {
  bookingUtilizationId: string;
  batchKey: string | null;
  basePaise: number;
  chargeStatus: string;
};
type Program = {
  type: "CREDIT_POOL" | "LICENSED_SEAT";
  overageBehavior: "BLOCK" | "CHARGE_ORG" | "CHARGE_MEMBER";
  creditBudgetPerCycle?: number;
  priceCapPerEngagementPaise?: number | null;
  coveredEngagementsPerCycle?: number | null;
};

const within = (v: number, r?: Range) =>
  !r ||
  ((r.lte === undefined || v <= r.lte) &&
    (r.gte === undefined || v >= r.gte) &&
    (r.lt === undefined || v < r.lt));
const stepped = (v: number, s?: Step) =>
  v + (s?.increment ?? 0) - (s?.decrement ?? 0);
const uniqueViolation = () =>
  Object.assign(new Error("Unique constraint failed"), { code: "P2002" });

/** A 12-session plan sold for ₹12,000 (₹1,000 a session) on one org payment. */
function world(program: Program, parentLeg: "WALLET" | "LICENSE") {
  const config = {
    overageBehavior: program.overageBehavior,
    creditBudgetPerCycle: program.creditBudgetPerCycle ?? 0,
    priceCapPerEngagementPaise: program.priceCapPerEngagementPaise ?? null,
    coveredEngagementsPerCycle: program.coveredEngagementsPerCycle ?? null,
    overageSurchargeBps: null,
    maxOveragePerCyclePaise: null,
  };
  const configs = {
    licensedSeatConfig: program.type === "LICENSED_SEAT" ? config : null,
    creditPoolConfig: program.type === "CREDIT_POOL" ? config : null,
  };
  const s = {
    meter: { engagementsUsed: 0, consumedPaise: 0, overageCount: 0 } as Meter,
    util: null as null | {
      id: string;
      paymentId: string;
      engagementsConsumed: number;
      priceAtBookingPaise: number;
      wasOverage: boolean;
      appointmentIds: string[];
      reversedAt: Date | null;
    },
    ledger: [] as LedgerRow[],
    events: [] as Event[],
    intents: new Set<string>(),
    live: [] as string[],
  };
  let seq = 0;
  const orgPayment = {
    id: "pay-1",
    organizationId: "org-1",
    amount: parentLeg === "LICENSE" ? 0 : 1_200_000,
    originalAmount: 1_200_000,
    currency: "INR",
    paymentGateway: "RAZORPAY",
    createdAt: new Date(0),
  };
  const apply = (data: Partial<Record<keyof Meter, Step>>) => {
    for (const k of [
      "engagementsUsed",
      "consumedPaise",
      "overageCount",
    ] as const)
      s.meter[k] = stepped(s.meter[k], data[k]);
  };

  // The parent payment's one consultant earning, waiting out its hold.
  const holds = createEarningsHoldStore();
  holds.consultant.push({
    id: "ce-1",
    paymentId: "pay-1",
    status: "PENDING",
    preHoldStatus: null,
    holdUntil: null,
  });

  const tx = txDouble({
    ...holds.db,
    subscription: {
      findUnique: jest.fn(async () => ({
        id: "sub-1",
        subscriptionPlanId: "plan-1",
        sessionsTotal: 12,
        subscriptionPlan: { totalSessions: 12, price: 1_200_000 },
        appointment: {
          payment: [orgPayment],
          occurrences: s.live.map((id) => ({ id })),
        },
      })),
    },
    membership: {
      findUnique: jest.fn(async () => ({ id: "mem-1", status: "ACTIVE" })),
    },
    program: { findFirst: jest.fn(async () => configs) },
    programAssignment: {
      findFirst: jest.fn(async () => ({
        id: "asg-1",
        program: { type: program.type, ...configs },
      })),
      findUniqueOrThrow: jest.fn(async () => ({
        programId: "prog-1",
        membershipId: "mem-1",
        ...s.meter,
        program: { type: program.type, ...configs },
      })),
      findUnique: jest.fn(async () => ({
        periodStart: new Date(0),
        rolledFromAssignment: null,
      })),
      update: jest.fn(
        async ({ data }: { data: Partial<Record<keyof Meter, Step>> }) => {
          apply(data);
          return { ...s.meter };
        },
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Partial<Record<keyof Meter, Range>>;
          data: Partial<Record<keyof Meter, Step>>;
        }) => {
          const ok = (
            ["engagementsUsed", "consumedPaise", "overageCount"] as const
          ).every((k) => within(s.meter[k], where[k]));
          if (ok) apply(data);
          return { count: ok ? 1 : 0 };
        },
      ),
    },
    bookingUtilization: {
      findUnique: jest.fn(
        async ({ where }: { where: { paymentId: string } }) =>
          s.util && s.util.paymentId === where.paymentId
            ? {
                ...s.util,
                programAssignmentId: "asg-1",
                programAssignment: {
                  membershipId: "mem-1",
                  program: { type: program.type },
                },
              }
            : null,
      ),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) =>
        Object.assign(s.util ?? {}, data),
      ),
      upsert: jest.fn(
        async ({
          create,
          update,
        }: {
          create: {
            paymentId: string;
            engagementsConsumed: number;
            priceAtBookingPaise: number;
            wasOverage: boolean;
            appointmentIds: string[];
          };
          update: {
            engagementsConsumed: Step;
            priceAtBookingPaise: Step;
            wasOverage?: boolean;
            appointmentIds?: { push: string[] };
          };
        }) => {
          if (!s.util) {
            s.util = { id: "bu-1", reversedAt: null, ...create };
            return s.util;
          }
          s.util.engagementsConsumed = stepped(
            s.util.engagementsConsumed,
            update.engagementsConsumed,
          );
          s.util.priceAtBookingPaise = stepped(
            s.util.priceAtBookingPaise,
            update.priceAtBookingPaise,
          );
          if (update.wasOverage) s.util.wasOverage = true;
          s.util.appointmentIds.push(...(update.appointmentIds?.push ?? []));
          return s.util;
        },
      ),
    },
    usageLedgerEntry: {
      create: jest.fn(
        async ({ data }: { data: Omit<LedgerRow, "id" | "createdAt"> }) => {
          seq += 1;
          const row = { id: `ule-${seq}`, createdAt: new Date(seq), ...data };
          s.ledger.push(row);
          return row;
        },
      ),
      aggregate: jest.fn(
        async ({
          where,
        }: {
          where: {
            paymentId: string;
            engagementsConsumed?: Range;
            priceAtBookingPaise?: Range;
          };
        }) => {
          const rows = s.ledger.filter(
            (r) =>
              r.paymentId === where.paymentId &&
              within(r.engagementsConsumed, where.engagementsConsumed) &&
              within(r.priceAtBookingPaise, where.priceAtBookingPaise),
          );
          return {
            _sum: {
              engagementsConsumed: rows.reduce(
                (a, r) => a + r.engagementsConsumed,
                0,
              ),
              priceAtBookingPaise: rows.reduce(
                (a, r) => a + r.priceAtBookingPaise,
                0,
              ),
            },
          };
        },
      ),
      findMany: jest.fn(async ({ where }: { where: { paymentId: string } }) =>
        s.ledger
          .filter((r) => r.paymentId === where.paymentId)
          .sort(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.engagementsConsumed - b.engagementsConsumed,
          ),
      ),
    },
    overageEvent: {
      aggregate: jest.fn(async () => ({
        _sum: {
          basePaise: s.events
            .filter(
              (e) =>
                !["REVERSED", "BLOCKED", "FAILED"].includes(e.chargeStatus),
            )
            .reduce((a, e) => a + e.basePaise, 0),
          surchargePaise: 0,
        },
      })),
      // (bookingUtilizationId, batchKey) is unique. A keyless write stands in
      // for the single-column unique this replaces, so base code collides.
      create: jest.fn(
        async ({ data }: { data: Event & { batchKey?: string | null } }) => {
          const key = data.batchKey ?? null;
          if (
            s.events.some(
              (e) =>
                e.bookingUtilizationId === data.bookingUtilizationId &&
                e.batchKey === key,
            )
          )
            throw uniqueViolation();
          s.events.push({ ...data, batchKey: key });
          return { id: `ev-${s.events.length}` };
        },
      ),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    payment: {
      findUnique: jest.fn(async () => ({
        billableToOrgInvoiceId: null,
        buyerCountry: "IN",
        consumerStateCode: null,
        isInternational: false,
        billingAccountId: "ba-1",
      })),
      create: jest.fn(async ({ data }: { data: { paymentIntent: string } }) => {
        if (s.intents.has(data.paymentIntent)) throw uniqueViolation();
        s.intents.add(data.paymentIntent);
        return { id: `side-${s.intents.size}` };
      }),
      update: jest.fn(async () => ({})),
    },
    paymentLeg: {
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: { paymentId_source: { source: string } };
        }) =>
          where.paymentId_source.source === parentLeg
            ? { amountPaise: orgPayment.amount }
            : null,
      ),
      update: jest.fn(async () => ({})),
    },
  });

  /** One allocation batch; `replace` re-places the whole plan with these sessions. */
  const allocate = (ids: string[], replace = false) => {
    s.live = replace ? [...ids] : [...s.live, ...ids];
    return recordSubscriptionAllocationCap(tx, "sub-1", "consultee-1", ids);
  };
  return { s, tx, allocate, holds };
}

describe("a CREDIT_POOL subscription meters each batch per session", () => {
  it("meters one session on the first allocation and passes a per-session cap", async () => {
    const w = world(
      {
        type: "CREDIT_POOL",
        overageBehavior: "BLOCK",
        creditBudgetPerCycle: 12_000,
        priceCapPerEngagementPaise: 100_000,
      },
      "WALLET",
    );

    await w.allocate(["occ-1"]);

    expect(w.s.meter).toMatchObject({
      engagementsUsed: 1,
      consumedPaise: 100_000,
    });
  });

  it("gives every over-budget batch its own OverageEvent", async () => {
    // ₹2,500 of credit covers two and a half sessions.
    const w = world(
      {
        type: "CREDIT_POOL",
        overageBehavior: "CHARGE_ORG",
        creditBudgetPerCycle: 2_500,
      },
      "WALLET",
    );

    await w.allocate(["occ-1", "occ-2"]);
    expect(w.s.events).toHaveLength(0);
    await w.allocate(["occ-3"]);
    await w.allocate(["occ-4"]);

    expect(w.s.meter.consumedPaise).toBe(400_000);
    expect(
      w.s.events.map((e) => [e.bookingUtilizationId, e.batchKey, e.basePaise]),
    ).toEqual([
      ["bu-1", w.s.ledger[1].id, 50_000],
      ["bu-1", w.s.ledger[2].id, 100_000],
    ]);
  });

  it("returns exactly the removed sessions' credit on a re-allocation", async () => {
    const w = world(
      {
        type: "CREDIT_POOL",
        overageBehavior: "BLOCK",
        creditBudgetPerCycle: 12_000,
      },
      "WALLET",
    );

    await w.allocate(["occ-1", "occ-2", "occ-3"]);
    // Three sessions re-placed as one: one is substituted, two are removed.
    await w.allocate(["occ-9"], true);

    expect(w.s.meter).toMatchObject({
      engagementsUsed: 1,
      consumedPaise: 100_000,
    });
    expect(w.s.ledger.at(-1)).toMatchObject({
      engagementsConsumed: -2,
      priceAtBookingPaise: -200_000,
    });
  });
});

describe("a LICENSED_SEAT subscription that charges the member", () => {
  it("bills each over-cap batch on its own side-payment", async () => {
    const w = world(
      {
        type: "LICENSED_SEAT",
        overageBehavior: "CHARGE_MEMBER",
        coveredEngagementsPerCycle: 1,
      },
      "LICENSE",
    );

    await w.allocate(["occ-1"]);
    await w.allocate(["occ-2"]);
    await w.allocate(["occ-3"]);

    expect(w.s.events.map((e) => [e.batchKey, e.basePaise])).toEqual([
      [w.s.ledger[1].id, 100_000],
      [w.s.ledger[2].id, 100_000],
    ]);
    expect(w.s.intents.size).toBe(2);
    // The parent's earning waits on the unpaid member charges: one OVERAGE
    // hold keyed on the parent, however many batches went over the cap.
    expect(w.holds.consultant[0]).toMatchObject({
      status: "HELD",
      preHoldStatus: "PENDING",
    });
    expect(
      w.holds.holds.map((h) => [h.reason, h.sourceRef, h.releasedAt]),
    ).toEqual([["OVERAGE", "pay-1", null]]);
  });
});

describe("a re-bought class seat reverses only its own sale", () => {
  /** A 3-session seat sold at ₹3,000, lapsed and fully reversed, re-bought at ₹1,500. */
  function remintedSeat() {
    const w = world(
      {
        type: "CREDIT_POOL",
        overageBehavior: "BLOCK",
        creditBudgetPerCycle: 12_000,
      },
      "WALLET",
    );
    const row = (
      n: number,
      engagementsConsumed: number,
      priceAtBookingPaise: number,
    ) => ({
      id: `ule-${n}`,
      paymentId: "pay-1",
      engagementsConsumed,
      priceAtBookingPaise,
      wasOverage: false,
      createdAt: new Date(n),
    });
    w.s.ledger.push(
      row(1, 3, 300_000),
      row(2, -3, -300_000),
      row(3, 3, 150_000),
    );
    w.s.util = {
      id: "bu-1",
      paymentId: "pay-1",
      engagementsConsumed: 6,
      priceAtBookingPaise: 450_000,
      wasOverage: false,
      appointmentIds: ["a1", "a2", "a3"],
      reversedAt: null,
    };
    w.s.meter = { engagementsUsed: 3, consumedPaise: 150_000, overageCount: 0 };
    return w;
  }

  it("a partial refund reverses that refund's share of the re-bought sale", async () => {
    const w = remintedSeat();

    await reverseBookingUtilization(w.tx, {
      paymentId: "pay-1",
      refundRatio: { refundAmountPaise: 50_000, paymentAmountPaise: 150_000 },
    });

    expect(w.s.meter).toMatchObject({
      engagementsUsed: 2,
      consumedPaise: 100_000,
    });
  });

  it("a full reversal returns the re-bought sale and nothing of the earlier one", async () => {
    const w = remintedSeat();

    await reverseBookingUtilization(w.tx, { paymentId: "pay-1" });

    expect(w.s.meter).toMatchObject({ engagementsUsed: 0, consumedPaise: 0 });
    expect(w.s.ledger.at(-1)).toMatchObject({
      engagementsConsumed: -3,
      priceAtBookingPaise: -150_000,
    });
  });
});

describe("a credit pool's partial refunds return the whole price between them", () => {
  it("two half refunds of a one-session booking return all of its credit", async () => {
    const w = world(
      {
        type: "CREDIT_POOL",
        overageBehavior: "BLOCK",
        creditBudgetPerCycle: 12_000,
      },
      "WALLET",
    );
    w.s.ledger.push({
      id: "ule-1",
      paymentId: "pay-1",
      engagementsConsumed: 1,
      priceAtBookingPaise: 100_000,
      wasOverage: false,
      createdAt: new Date(1),
    });
    w.s.util = {
      id: "bu-1",
      paymentId: "pay-1",
      engagementsConsumed: 1,
      priceAtBookingPaise: 100_000,
      wasOverage: false,
      appointmentIds: ["a1"],
      reversedAt: null,
    };
    w.s.meter = { engagementsUsed: 1, consumedPaise: 100_000, overageCount: 0 };
    const half = { refundAmountPaise: 50_000, paymentAmountPaise: 100_000 };

    await reverseBookingUtilization(w.tx, {
      paymentId: "pay-1",
      refundRatio: half,
    });
    await reverseBookingUtilization(w.tx, {
      paymentId: "pay-1",
      refundRatio: half,
    });

    expect(w.s.meter).toMatchObject({ engagementsUsed: 0, consumedPaise: 0 });
  });
});
