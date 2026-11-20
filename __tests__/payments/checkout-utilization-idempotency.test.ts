/**
 * @jest-environment node
 */

/**
 * A replayed checkout must not meter the same booking twice.
 *
 * `recordBookingUtilization` grew a set-diff idempotency guard in PR-1e (G3),
 * but it only arms itself when the caller NAMES the appointments it is
 * counting. Checkout — the CONSULTATION / WEBINAR / CLASS debit — never passed
 * `appointmentIds`, so the guard was inert for every one of them and the
 * "legacy caller" branch incremented unconditionally: a retried webhook or a
 * resumed order against the same Payment charged the org's cap twice.
 */

jest.mock("../../lib/payments/operations/prior-intent-tombstone", () => ({
  __esModule: true,
  tombstonePriorIntent: jest.fn(async () => undefined),
}));

import { recordBookingUtilization } from "@/lib/api/organizations/program-helpers";
import { writeCheckoutPayment } from "@/lib/payments/checkout/commit/payment-row";
import { findPriorSeatPayment } from "@/lib/payments/checkout/seats";
import type { CheckoutCommitInput } from "@/lib/payments/checkout/commit/types";
import type { Tx } from "@/lib/prisma";

/**
 * An in-memory stand-in for the three tables the helper touches, so the
 * assertion is on real behaviour rather than on which mock was called.
 * Uncapped LICENSED_SEAT — the cap arithmetic is not what is under test.
 */
function makeFakeTx() {
  const state = {
    engagementsUsed: 0,
    util: null as null | {
      appointmentIds: string[];
      engagementsConsumed: number;
      reversedAt: Date | null;
    },
    ledger: [] as { engagementsConsumed: number }[],
  };

  const tx = {
    programAssignment: {
      findUniqueOrThrow: async () => ({
        programId: "program-1",
        membershipId: "membership-1",
        engagementsUsed: state.engagementsUsed,
        consumedPaise: 0,
        program: {
          type: "LICENSED_SEAT",
          licensedSeatConfig: null,
          creditPoolConfig: null,
        },
      }),
      update: async ({
        data,
      }: {
        data: { engagementsUsed?: { increment: number } };
      }) => {
        state.engagementsUsed += data.engagementsUsed?.increment ?? 0;
        return { engagementsUsed: state.engagementsUsed };
      },
      updateMany: async () => ({ count: 1 }),
    },
    bookingUtilization: {
      findUnique: async () => state.util,
      updateMany: async ({
        where,
        data,
      }: {
        where: { reversedAt?: { not: null } };
        data: { appointmentIds?: string[]; reversedAt?: null };
      }) => {
        if (!state.util) return { count: 0 };
        if (where.reversedAt && state.util.reversedAt === null) {
          return { count: 0 };
        }
        Object.assign(state.util, data);
        return { count: 1 };
      },
      upsert: async ({
        create,
        update,
      }: {
        create: { engagementsConsumed: number; appointmentIds: string[] };
        update: {
          engagementsConsumed: { increment: number };
          appointmentIds?: { push: string[] };
        };
      }) => {
        if (!state.util) {
          state.util = {
            engagementsConsumed: create.engagementsConsumed,
            appointmentIds: [...create.appointmentIds],
            reversedAt: null,
          };
        } else {
          state.util.engagementsConsumed +=
            update.engagementsConsumed.increment;
          state.util.appointmentIds.push(
            ...(update.appointmentIds?.push ?? []),
          );
        }
        return state.util;
      },
    },
    payment: {
      findFirst: async () => ({
        id: "pay-1",
        userId: "buyer-1",
        paymentIntent: "order_OLD",
        paymentStatus: "EXPIRED",
        amount: 250_000,
        refunds: [],
      }),
      updateMany: async () => ({ count: 1 }),
    },
    appointmentParticipant: {
      updateMany: async () => ({ count: 1 }),
    },
    usageLedgerEntry: {
      create: async ({ data }: { data: { engagementsConsumed: number } }) => {
        state.ledger.push({ engagementsConsumed: data.engagementsConsumed });
        return data;
      },
    },
  };

  return { state, tx: tx as unknown as Tx };
}

const CALL = {
  programAssignmentId: "assign-1",
  paymentId: "pay-1",
  engagementsConsumed: 1,
  priceAtBookingPaise: 250_000,
};

describe("PR-1e (G3) — the set-diff guard needs the caller to name the appointments", () => {
  it("counts a replayed call once when appointmentIds are supplied", async () => {
    const { state, tx } = makeFakeTx();

    await recordBookingUtilization(tx, {
      ...CALL,
      appointmentIds: ["apt-1"],
    });
    const replay = await recordBookingUtilization(tx, {
      ...CALL,
      appointmentIds: ["apt-1"],
    });

    expect(replay.engagementsConsumedDelta).toBe(0);
    expect(state.engagementsUsed).toBe(1);
    expect(state.util?.engagementsConsumed).toBe(1);
    // No second ledger row: the replay short-circuits before the write.
    expect(state.ledger).toHaveLength(1);
  });

  it("still counts genuinely new appointments on a later call", async () => {
    const { state, tx } = makeFakeTx();

    await recordBookingUtilization(tx, { ...CALL, appointmentIds: ["apt-1"] });
    await recordBookingUtilization(tx, {
      ...CALL,
      engagementsConsumed: 2,
      appointmentIds: ["apt-1", "apt-2"],
    });

    expect(state.engagementsUsed).toBe(2);
    expect(state.util?.appointmentIds).toEqual(["apt-1", "apt-2"]);
  });

  it("double-counts the replay when the ids are omitted — the shape checkout had", async () => {
    const { state, tx } = makeFakeTx();

    await recordBookingUtilization(tx, CALL);
    await recordBookingUtilization(tx, CALL);

    expect(state.engagementsUsed).toBe(2);
    expect(state.ledger).toHaveLength(2);
  });
});

/** The checkout input for re-buying a PERSONAL-rail webinar seat under a programme. */
const REBUY = {
  validatedData: {
    appointmentType: "WEBINAR",
    planId: "plan-1",
    eventId: "webinar-1",
    paymentGateway: "RAZORPAY",
  },
  userId: "buyer-1",
  isMockPayment: false,
  mintedOrder: { id: "order_NEW", client_secret: null },
  holdExpiresAt: new Date("2030-01-01T00:00:00Z"),
  organizationId: "org-1",
  billingAccountId: null,
  programAssignmentId: "assign-1",
  isOrgWalletPayment: false,
  isOrgInvoicedPayment: false,
  isOrgLicensedPayment: false,
  isOrgSponsoredPayment: false,
  isZeroAmountPayment: false,
  displayCurrencyAtCheckout: "INR",
  exchangeRateAtCheckout: null,
  priced: { amount: 250_000, currency: "INR" },
} as unknown as CheckoutCommitInput;

describe("a re-minted seat whose utilization was reversed", () => {
  it("meters the re-bought seat once more, and a replay of it stays a no-op", async () => {
    const { state, tx } = makeFakeTx();
    await recordBookingUtilization(tx, { ...CALL, appointmentIds: ["apt-1"] });
    // The lapsed payment's expiry gave the engagement back.
    state.engagementsUsed = 0;
    state.util!.reversedAt = new Date();
    state.ledger.push({ engagementsConsumed: -1 });

    // The webinar handler reads the prior seat before its revive and passes it down.
    const priorSeat = await findPriorSeatPayment(tx, "buyer-1", "apt-1");
    await writeCheckoutPayment(tx, REBUY, {
      createdAppointment: { id: "apt-1" },
      bookedPlan: null,
      skipPayment: false,
      priorSeat,
      eventPricePaise: 50_000,
    });
    await recordBookingUtilization(tx, { ...CALL, appointmentIds: ["apt-1"] });
    await recordBookingUtilization(tx, { ...CALL, appointmentIds: ["apt-1"] });

    expect(state.engagementsUsed).toBe(1);
    expect(state.ledger.map((row) => row.engagementsConsumed)).toEqual([
      1, -1, 1,
    ]);
    expect(state.util).toMatchObject({
      engagementsConsumed: 2,
      appointmentIds: ["apt-1"],
      reversedAt: null,
    });
  });
});
