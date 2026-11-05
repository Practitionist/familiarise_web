/**
 * A paid subscription's period allocation racing three consultee checkouts on
 * the same expert inside that period. Whatever the interleaving:
 *  - no two occupying rows of the host overlap;
 *  - the allocator re-searches around times a checkout holds;
 *  - every buyer either commits or gets a typed refusal before any payment
 *    row exists (never charged, then refunded).
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import {
  futureAt,
  gate,
  HOUR_MS,
  overlappingOccupyingPairs,
  seedConsultee,
  seedHost,
  seedPaidSubscription,
  type SeededConsultee,
  type SeededHost,
} from "./harness";
import { seedBuyer, seedConsultationPlan } from "./harness-host";

jest.mock("../../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: jest.fn(async () => ({
    id: `order_${randomUUID()}`,
    client_secret: null,
  })),
  cancelPaymentIntent: jest.fn(async () => undefined),
}));
jest.mock("../../../lib/compliance/dpdp", () => ({
  __esModule: true,
  checkConsent: jest.fn(async () => true),
}));
jest.mock("../../../lib/novu", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});

/** Parks the allocator at the top of its write transaction, slot batch held. */
const guardGate = { current: null as ReturnType<typeof gate> | null };
jest.mock("../../../lib/booking/allocation/guards", () => {
  const actual = jest.requireActual("../../../lib/booking/allocation/guards");
  return {
    ...actual,
    guardAllocationInTx: async (...args: unknown[]) => {
      const g = guardGate.current;
      if (g) {
        guardGate.current = null;
        await g.park();
      }
      return actual.guardAllocationInTx(...args);
    },
  };
});

/** Parks the allocator right after its search returns, before it locks anything. */
const searchGate = { current: null as ReturnType<typeof gate> | null };
jest.mock("../../../lib/booking/allocation/search/find-available-slots", () => {
  const actual = jest.requireActual(
    "../../../lib/booking/allocation/search/find-available-slots",
  );
  return {
    ...actual,
    findAvailableSlots: async (...args: unknown[]) => {
      const picked = await actual.findAvailableSlots(...args);
      const g = searchGate.current;
      if (g) {
        searchGate.current = null;
        await g.park();
      }
      return picked;
    },
  };
});

/** Parks checkouts (in call order) after their in-lock re-validation, atoms held. */
const checkoutGates: ReturnType<typeof gate>[] = [];
jest.mock("../../../lib/payments/checkout/revalidate", () => {
  const actual = jest.requireActual(
    "../../../lib/payments/checkout/revalidate",
  );
  return {
    ...actual,
    revalidateInsideLock: async (...args: unknown[]) => {
      const g = checkoutGates.shift();
      const result = await actual.revalidateInsideLock(...args);
      if (g) await g.park();
      return result;
    },
  };
});

/** Parks the allocator after its out-of-tx validation, before it takes the slot batch. */
const batchGate = { current: null as ReturnType<typeof gate> | null };
jest.mock("../../../utils/appointmentlock", () => {
  const actual = jest.requireActual("../../../utils/appointmentlock");
  return {
    ...actual,
    tryLockSlotBatch: async (...args: unknown[]) => {
      const g = batchGate.current;
      if (g) {
        batchGate.current = null;
        await g.park();
      }
      return actual.tryLockSlotBatch(...args);
    },
  };
});

import { allocate } from "../../../lib/booking/allocation";
import { handleCheckout } from "../../../lib/payments/checkout";
import {
  classifyError as classifyCheckoutError,
  ErrorTypes,
} from "../../../lib/errors/classification/payment-error-classification";

/** One published hour at 09:00 UTC on each of `days`. */
async function publishMornings(host: SeededHost, days: number[]) {
  await prisma.consultantProfile.update({
    where: { id: host.consultantProfileId },
    data: { verificationStatus: "VERIFIED", scheduleType: "CUSTOM" },
  });
  await prisma.availabilityWindowCustom.createMany({
    data: days.map((day) => ({
      consultantProfileId: host.consultantProfileId,
      startsAt: futureAt(day, 9),
      endsAt: futureAt(day, 10),
    })),
  });
}

function checkoutAt(planId: string, startsAt: Date) {
  return {
    appointmentType: "CONSULTATION" as const,
    planId,
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + HOUR_MS).toISOString(),
    paymentGateway: "RAZORPAY" as const,
    clientIdempotencyKey: `period-race-${randomUUID()}`,
    consumerStateCode: "29",
  };
}

/**
 * A typed refusal the checkout route answers (its classifier's slot-taken or
 * busy type, a 4xx business error), never a 500 fault.
 */
function refusedBeforePayment(outcome: unknown): boolean {
  if (!(outcome instanceof Error)) return false;
  const { httpStatus, isBusinessError, errorType } =
    classifyCheckoutError(outcome);
  return (
    isBusinessError &&
    httpStatus >= 400 &&
    httpStatus < 500 &&
    (errorType === ErrorTypes.AVAILABILITY ||
      errorType === ErrorTypes.LOCK_CONTENTION)
  );
}

async function paymentsOf(userId: string): Promise<number> {
  return prisma.payment.count({ where: { userId } });
}

async function placedStarts(subscriptionId: string): Promise<number[]> {
  const rows = await prisma.appointmentOccurrence.findMany({
    where: { appointment: { subscriptionId }, deletedAt: null },
    select: { startsAt: true },
    orderBy: { startsAt: "asc" },
  });
  return rows.map((r) => r.startsAt.getTime());
}

describe("subscription period allocation × 3 consultee checkouts", () => {
  it("allocator holding its picks first: buyers on picked times are refused before paying, the third commits", async () => {
    const host = await seedHost();
    await publishMornings(host, [3, 4, 5, 6]);
    const subscriber = await seedConsultee();
    const sub = await seedPaidSubscription(host, subscriber, futureAt(3, 0));
    const plan = await seedConsultationPlan(host, "Instant consultation");
    const [b1, b2, b3] = [
      await seedBuyer(),
      await seedBuyer(),
      await seedBuyer(),
    ];

    const paused = gate();
    guardGate.current = paused;
    const allocating = allocate({
      eventType: "subscription",
      eventId: sub.subscriptionId,
      mode: "auto",
    });
    await Promise.race([
      paused.arrived,
      allocating.then((r) => {
        throw new Error(
          `allocator finished before parking: ${JSON.stringify(r)}`,
        );
      }),
    ]);

    // The allocator spreads a week's sessions (a free day between them), so
    // it holds the 3rd and 5th mornings; the 4th stays free for a buyer.
    const outcomes = await Promise.all(
      [
        [b1, futureAt(3, 9)],
        [b2, futureAt(5, 9)],
        [b3, futureAt(4, 9)],
      ].map(([buyer, at]) =>
        handleCheckout(
          checkoutAt(plan.id, at as Date),
          (buyer as SeededConsultee).userId,
        ).then(
          () => "committed" as const,
          (error: unknown) => error,
        ),
      ),
    );
    paused.open();
    const allocation = await allocating;

    expect(allocation).toMatchObject({ success: true });
    expect(await placedStarts(sub.subscriptionId)).toEqual([
      futureAt(3, 9).getTime(),
      futureAt(5, 9).getTime(),
    ]);
    expect(refusedBeforePayment(outcomes[0])).toBe(true);
    expect(refusedBeforePayment(outcomes[1])).toBe(true);
    expect(outcomes[2]).toBe("committed");
    expect(await paymentsOf(b1.userId)).toBe(0);
    expect(await paymentsOf(b2.userId)).toBe(0);
    expect(await overlappingOccupyingPairs(host.consultantProfileId)).toBe(0);
  }, 45_000);

  it("checkouts holding the earliest times first: the allocator re-searches around them, a late buyer is refused before paying", async () => {
    const host = await seedHost();
    await publishMornings(host, [3, 4, 5, 6]);
    const subscriber = await seedConsultee();
    const sub = await seedPaidSubscription(host, subscriber, futureAt(3, 0));
    const plan = await seedConsultationPlan(host, "Instant consultation");
    const [b1, b2, b3] = [
      await seedBuyer(),
      await seedBuyer(),
      await seedBuyer(),
    ];

    // B1 and B2 are mid-commit on the two earliest-fit mornings, atoms held.
    const g1 = gate();
    const g2 = gate();
    checkoutGates.push(g1, g2);
    const first = handleCheckout(
      checkoutAt(plan.id, futureAt(3, 9)),
      b1.userId,
    );
    await g1.arrived;
    const second = handleCheckout(
      checkoutAt(plan.id, futureAt(4, 9)),
      b2.userId,
    );
    await g2.arrived;

    const allocation = await allocate({
      eventType: "subscription",
      eventId: sub.subscriptionId,
      mode: "auto",
    });
    g1.open();
    g2.open();
    const [c1, c2] = await Promise.allSettled([first, second]);

    // Re-searched past the held mornings, inside one search budget.
    expect(allocation).toMatchObject({ success: true });
    expect(await placedStarts(sub.subscriptionId)).toEqual([
      futureAt(5, 9).getTime(),
      futureAt(6, 9).getTime(),
    ]);
    // Whole settled outcome, so a refusal prints its reason.
    expect(c1).toMatchObject({ status: "fulfilled" });
    expect(c2).toMatchObject({ status: "fulfilled" });

    // A third buyer on a morning the allocator placed is refused, unpaid.
    const late = await handleCheckout(
      checkoutAt(plan.id, futureAt(5, 9)),
      b3.userId,
    ).then(
      () => "committed" as const,
      (error: unknown) => error,
    );
    expect(refusedBeforePayment(late)).toBe(true);
    expect(await paymentsOf(b3.userId)).toBe(0);
    expect(await overlappingOccupyingPairs(host.consultantProfileId)).toBe(0);
  }, 45_000);

  it("a checkout committing between the allocator's search and its lock: re-validated, never an overlap", async () => {
    const host = await seedHost();
    await publishMornings(host, [3, 4, 5, 6]);
    const subscriber = await seedConsultee();
    const sub = await seedPaidSubscription(host, subscriber, futureAt(3, 0));
    const plan = await seedConsultationPlan(host, "Instant consultation");
    const buyer = await seedBuyer();

    const paused = gate();
    searchGate.current = paused;
    const allocating = allocate({
      eventType: "subscription",
      eventId: sub.subscriptionId,
      mode: "auto",
    });
    await Promise.race([
      paused.arrived,
      allocating.then((r) => {
        throw new Error(
          `allocator finished before parking: ${JSON.stringify(r)}`,
        );
      }),
    ]);
    // The search picked the day-3 and day-4 mornings; a buyer takes day 3 now.
    await handleCheckout(checkoutAt(plan.id, futureAt(3, 9)), buyer.userId);
    paused.open();
    const allocation = await allocating;

    // The out-of-tx validation sees the committed hold: a typed refusal.
    expect(allocation).toMatchObject({
      success: false,
      errorCode: "VALIDATION_ERROR",
      httpStatus: 400,
    });
    expect(await placedStarts(sub.subscriptionId)).toEqual([]);
    expect(await overlappingOccupyingPairs(host.consultantProfileId)).toBe(0);
  }, 45_000);

  it("a checkout committing after the allocator validated, before its write: the in-transaction re-check refuses it as taken", async () => {
    const host = await seedHost();
    await publishMornings(host, [3, 4, 5, 6]);
    const subscriber = await seedConsultee();
    const sub = await seedPaidSubscription(host, subscriber, futureAt(3, 0));
    const plan = await seedConsultationPlan(host, "Instant consultation");
    const buyer = await seedBuyer();

    const paused = gate();
    batchGate.current = paused;
    const allocating = allocate({
      eventType: "subscription",
      eventId: sub.subscriptionId,
      mode: "auto",
    });
    await Promise.race([
      paused.arrived,
      allocating.then((r) => {
        throw new Error(
          `allocator finished before parking: ${JSON.stringify(r)}`,
        );
      }),
    ]);
    // Validated day 3 and day 4, nothing locked yet; a buyer takes day 3 now.
    await handleCheckout(checkoutAt(plan.id, futureAt(3, 9)), buyer.userId);
    paused.open();
    const allocation = await allocating;

    expect(allocation).toMatchObject({
      success: false,
      errorCode: "SLOT_TAKEN",
      httpStatus: 409,
    });
    expect(await placedStarts(sub.subscriptionId)).toEqual([]);
    expect(await overlappingOccupyingPairs(host.consultantProfileId)).toBe(0);
  }, 45_000);
});
