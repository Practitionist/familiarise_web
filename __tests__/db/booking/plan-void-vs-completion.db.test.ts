/**
 * A void and a session completion on one plan serialise, on real Postgres: each
 * takes the plan's advisory lock before it reads the sessions, so the second
 * waits for the first to commit and reads its result. Whichever commits first,
 * every tranche whose cycle is delivered ends with a date and every tranche
 * whose cycle is not ends with none.
 */
import prisma from "../../../lib/prisma";
import {
  gate,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedPaidSubscription,
  untilLockWaiter,
} from "./harness";

import {
  settleSubscriptionCycle,
  unstampUndeliveredTranches,
} from "../../../lib/booking/subscription-cycle";
import type { Tx } from "../../../lib/prisma";

const DAY_MS = 24 * HOUR_MS;
const STAMPED = new Date(Date.now() + 3 * DAY_MS);

/**
 * A live plan of two sessions a cycle. Sessions 1..delivered are COMPLETED and
 * the next one has ended but is still SCHEDULED; one more, in the future, keeps
 * the plan's cycle open. Tranches up to `stampedThrough` carry a date.
 */
async function seedPlan(shape: {
  totalSessions: number;
  delivered: number;
  stampedThrough: number;
}) {
  const host = await seedHost();
  const buyer = await seedConsultee();
  const periodStart = new Date(Date.now() - 20 * DAY_MS);
  const { subscriptionId, appointmentId } = await seedPaidSubscription(
    host,
    buyer,
    periodStart,
    { sessionsPerWeek: 2, totalSessions: shape.totalSessions },
  );
  await prisma.subscription.update({
    where: { id: subscriptionId },
    data: { status: "APPROVED" },
  });
  const payment = await prisma.payment.findFirstOrThrow({
    where: { appointmentId },
    select: { id: true },
  });
  const session = (
    ordinal: number,
    startsAt: Date,
    completionStatus: "COMPLETED" | "SCHEDULED",
  ) =>
    prisma.appointmentOccurrence.create({
      data: {
        appointmentId,
        ordinal,
        startsAt,
        endsAt: new Date(startsAt.getTime() + HOUR_MS),
        isTentative: false,
        consultantProfileId: host.consultantProfileId,
        completionStatus,
        ...(completionStatus === "COMPLETED" && { completedAt: startsAt }),
      },
    });
  const sessions = [];
  for (let n = 1; n <= shape.delivered + 1; n++) {
    sessions.push(
      await session(
        n,
        new Date(periodStart.getTime() + n * DAY_MS),
        n <= shape.delivered ? "COMPLETED" : "SCHEDULED",
      ),
    );
  }
  await session(
    shape.delivered + 2,
    new Date(Date.now() + 5 * DAY_MS),
    "SCHEDULED",
  );
  const tranches = shape.totalSessions / 2;
  for (let k = 0; k < tranches; k++) {
    await prisma.consultantEarnings.create({
      data: {
        consultantProfileId: host.consultantProfileId,
        paymentId: payment.id,
        grossAmount: BigInt(100_000),
        platformFeePaise: BigInt(20_000),
        consultantSharePaise: BigInt(80_000),
        cycleOrdinal: k,
        status: "PENDING",
        holdUntil: k <= shape.stampedThrough ? STAMPED : null,
      },
    });
  }
  return {
    appointmentId,
    paymentId: payment.id,
    voided: sessions[0].id,
    completing: sessions[shape.delivered].id,
  };
}

type Plan = Awaited<ReturnType<typeof seedPlan>>;

/** The void door's order: the session leaves delivery, then the stamps follow. */
const voidDelivered = (plan: Plan) => async (tx: Tx) => {
  const now = new Date();
  await tx.appointmentOccurrence.update({
    where: { id: plan.voided },
    data: { completionStatus: "VOIDED", voidedAt: now, completedAt: null },
  });
  await unstampUndeliveredTranches(tx, {
    appointmentId: plan.appointmentId,
    now,
  });
};

const completeNext = (plan: Plan) => async (tx: Tx) => {
  const now = new Date();
  await tx.appointmentOccurrence.update({
    where: { id: plan.completing },
    data: { completionStatus: "COMPLETED", completedAt: now },
  });
  await settleSubscriptionCycle(tx, { appointmentId: plan.appointmentId, now });
};

/** Runs `first` to the end of its work, starts `second` behind its lock, then lets both commit. */
async function race(
  first: (tx: Tx) => Promise<void>,
  second: (tx: Tx) => Promise<void>,
) {
  const parked = gate();
  const opts = { timeout: 20_000 };
  const leading = prisma.$transaction(async (tx) => {
    await first(tx);
    await parked.park();
  }, opts);
  await parked.arrived;
  const trailing = prisma.$transaction((tx) => second(tx), opts);
  await untilLockWaiter();
  parked.open();
  await Promise.all([leading, trailing]);
}

const datedTranches = async (paymentId: string) =>
  (
    await prisma.consultantEarnings.findMany({
      where: { paymentId },
      orderBy: { cycleOrdinal: "asc" },
      select: { holdUntil: true },
    })
  ).map((t) => t.holdUntil !== null);

describe.each([
  {
    // 3 of 6 delivered, tranche 1 undated; the void leaves 2, the completion makes 3.
    name: "a completion must not date a tranche the void left one session short",
    shape: { totalSessions: 6, delivered: 3, stampedThrough: 0 },
    dated: [true, false, false],
  },
  {
    // 4 of 8 delivered, tranche 1 dated; the void leaves 3, the completion makes 4.
    name: "a void must not clear a tranche the completion delivered again",
    shape: { totalSessions: 8, delivered: 4, stampedThrough: 1 },
    dated: [true, true, false, false],
  },
])("$name", ({ shape, dated }) => {
  it("when the void commits first", async () => {
    const plan = await seedPlan(shape);
    await race(voidDelivered(plan), completeNext(plan));
    expect(await datedTranches(plan.paymentId)).toEqual(dated);
  });

  it("when the completion commits first", async () => {
    const plan = await seedPlan(shape);
    await race(completeNext(plan), voidDelivered(plan));
    expect(await datedTranches(plan.paymentId)).toEqual(dated);
  });
});
