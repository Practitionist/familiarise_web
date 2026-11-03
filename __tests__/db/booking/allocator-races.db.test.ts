/**
 * The allocator and the buyer doors serialise on the host's slot atoms (one
 * all-or-nothing batch), so for one host time:
 *  - allocator × checkout: exactly one commits, the other gets a typed refusal;
 *  - two allocators for two consultees of one host: the loser re-searches (auto)
 *    or is told the picked times were taken (manual);
 *  - a dual-role user U booking expert E at T while U's client books U at T:
 *    U's own atoms make exactly one of them commit.
 * Every case ends on the raw-SQL no-overlap invariant.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import {
  futureAt,
  gate,
  HOUR_MS,
  overlappingOccupyingPairs,
  seedConsultee,
  seedDualRole,
  seedHost,
  type SeededConsultee,
  type SeededHost,
} from "./harness";

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
/** Parks the allocator at the top of its write transaction, before any re-check. */
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

/** Parks the allocator inside its write transaction, slot batch held. */
const allocatorGate = { current: null as ReturnType<typeof gate> | null };
jest.mock("../../../lib/booking/allocation/collaborators", () => {
  const actual = jest.requireActual(
    "../../../lib/booking/allocation/collaborators",
  );
  return {
    ...actual,
    assertCollaboratorsFree: async (...args: unknown[]) => {
      const g = allocatorGate.current;
      if (g) {
        allocatorGate.current = null;
        await g.park();
      }
      return actual.assertCollaboratorsFree(...args);
    },
  };
});

/** Waits for the parked allocator; an allocation that ends before parking fails the test with its answer. */
async function parkedOrFailed(
  paused: ReturnType<typeof gate>,
  allocating: Promise<unknown>,
) {
  await Promise.race([
    paused.arrived,
    allocating.then((result) => {
      throw new Error(
        `allocator finished before parking: ${JSON.stringify(result)}`,
      );
    }),
  ]);
}

import { allocate } from "../../../lib/booking/allocation";
import {
  tryLockSlotBatch,
  unlockSlotInterval,
} from "../../../utils/appointmentlock";
import { halfHourStarts, publishOnly, seedRequest } from "./harness-host";
import { handleCheckout } from "../../../lib/payments/checkout";

/** A whole published week, so checkout's coverage check passes for any future hour. */
async function publishEveryHour(host: SeededHost) {
  await prisma.consultantProfile.update({
    where: { id: host.consultantProfileId },
    data: { verificationStatus: "VERIFIED", scheduleType: "CUSTOM" },
  });
  await prisma.availabilityWindowCustom.create({
    data: {
      consultantProfileId: host.consultantProfileId,
      startsAt: new Date(Date.now() - HOUR_MS),
      endsAt: new Date(Date.now() + 30 * 24 * HOUR_MS),
    },
  });
}

describe("allocator × checkout on one host time", () => {
  it("the allocator holding the atoms commits; the checkout is refused, never double-booked", async () => {
    const host = await seedHost();
    await publishEveryHour(host);
    const client = await seedConsultee();
    const request = await seedRequest(host, client);
    const plan = await prisma.consultationPlan.create({
      data: {
        title: "Instant consultation",
        price: BigInt(100_000),
        consultantProfileId: host.consultantProfileId,
        durationInHours: 1,
      },
    });
    const buyer = await seedConsultee();
    await prisma.consulteeProfile.update({
      where: { id: buyer.consulteeProfileId },
      data: { billingStateCode: "29" },
    });
    const startsAt = futureAt(5, 10);
    const endsAt = new Date(startsAt.getTime() + HOUR_MS);
    const paused = gate();
    allocatorGate.current = paused;

    const allocating = allocate({
      eventType: "consultation",
      eventId: request.consultationId,
      mode: "manual",
      slots: halfHourStarts(startsAt),
      override: true,
    });
    await parkedOrFailed(paused, allocating);
    const checkout = await handleCheckout(
      {
        appointmentType: "CONSULTATION",
        planId: plan.id,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        paymentGateway: "RAZORPAY",
        clientIdempotencyKey: `race-${randomUUID()}`,
        consumerStateCode: "29",
      },
      buyer.userId,
    ).then(
      () => "committed" as const,
      (error: unknown) => error,
    );
    paused.open();
    const allocation = await allocating;

    expect(allocation).toMatchObject({ success: true });
    expect(checkout).toBeInstanceOf(Error);
    expect((checkout as Error).message).toMatch(
      /being booked|currently booking/i,
    );
    expect(await overlappingOccupyingPairs(host.consultantProfileId)).toBe(0);
  }, 30_000);
});

describe("two allocators, one host, one time", () => {
  it("the second allocator for the same host is refused on the consultant key while the first writes", async () => {
    const host = await seedHost();
    const first = await seedRequest(host, await seedConsultee());
    const second = await seedRequest(host, await seedConsultee());
    const startsAt = futureAt(5, 14);
    const paused = gate();
    allocatorGate.current = paused;

    const winning = allocate({
      eventType: "consultation",
      eventId: first.consultationId,
      mode: "manual",
      slots: halfHourStarts(startsAt),
      override: true,
    });
    await parkedOrFailed(paused, winning);
    const losing = await allocate({
      eventType: "consultation",
      eventId: second.consultationId,
      mode: "manual",
      slots: halfHourStarts(startsAt),
      override: true,
    });
    paused.open();

    expect(await winning).toMatchObject({ success: true });
    expect(losing).toMatchObject({
      success: false,
      errorCode: "LOCK_CONTENTION",
      httpStatus: 409,
    });
    expect(await overlappingOccupyingPairs(host.consultantProfileId)).toBe(0);
  });
});

describe("dual-role U books expert E while U's own client books U", () => {
  it("U's own atoms let exactly one of the two commit at the same instant", async () => {
    const expertE = await seedHost();
    await publishEveryHour(expertE);
    const dualU = await seedDualRole();
    await publishEveryHour(dualU);
    await prisma.consulteeProfile.update({
      where: { id: dualU.consulteeProfileId },
      data: { billingStateCode: "29" },
    });
    const clientC = await seedConsultee();
    await prisma.consulteeProfile.update({
      where: { id: clientC.consulteeProfileId },
      data: { billingStateCode: "29" },
    });
    const planOfE = await prisma.consultationPlan.create({
      data: {
        title: "E's consultation",
        price: BigInt(100_000),
        consultantProfileId: expertE.consultantProfileId,
        durationInHours: 1,
      },
    });
    const planOfU = await prisma.consultationPlan.create({
      data: {
        title: "U's consultation",
        price: BigInt(100_000),
        consultantProfileId: dualU.consultantProfileId,
        durationInHours: 1,
      },
    });
    const startsAt = futureAt(5, 16);
    const window = {
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + HOUR_MS).toISOString(),
    };

    const outcomes = await Promise.allSettled([
      handleCheckout(
        {
          appointmentType: "CONSULTATION",
          planId: planOfE.id,
          ...window,
          paymentGateway: "RAZORPAY",
          clientIdempotencyKey: `u-books-e-${randomUUID()}`,
          consumerStateCode: "29",
        },
        dualU.userId,
      ),
      handleCheckout(
        {
          appointmentType: "CONSULTATION",
          planId: planOfU.id,
          ...window,
          paymentGateway: "RAZORPAY",
          clientIdempotencyKey: `c-books-u-${randomUUID()}`,
          consumerStateCode: "29",
        },
        clientC.userId,
      ),
    ]);

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
    // U's calendar: the session U hosts and the one U attends never overlap.
    const [{ pairs }] = await prisma.$queryRaw<{ pairs: number }[]>`
      SELECT count(*)::int AS pairs
      FROM "AppointmentOccurrence" a
      JOIN "AppointmentOccurrence" b ON a.id < b.id
       AND tstzrange(a."startsAt", a."endsAt") && tstzrange(b."startsAt", b."endsAt")
      WHERE a."deletedAt" IS NULL AND b."deletedAt" IS NULL
        AND a."completionStatus" <> 'CANCELLED' AND b."completionStatus" <> 'CANCELLED'
        AND (a."consultantProfileId" = ${dualU.consultantProfileId}
             OR EXISTS (SELECT 1 FROM "AppointmentParticipant" p
                        WHERE p."appointmentId" = a."appointmentId"
                          AND p."userId" = ${dualU.userId}
                          AND p.status IN ('HELD','CONFIRMED')))
        AND (b."consultantProfileId" = ${dualU.consultantProfileId}
             OR EXISTS (SELECT 1 FROM "AppointmentParticipant" p
                        WHERE p."appointmentId" = b."appointmentId"
                          AND p."userId" = ${dualU.userId}
                          AND p.status IN ('HELD','CONFIRMED')))`;
    expect(pairs).toBe(0);
  }, 30_000);
});

describe("auto allocation around a held time", () => {
  it("re-searches past the time an in-flight checkout holds and places the next free hour", async () => {
    const host = await seedHost();
    const startsAt = futureAt(5, 9);
    await publishOnly(host, {
      startsAt,
      endsAt: new Date(startsAt.getTime() + 2 * HOUR_MS),
    });
    const request = await seedRequest(host, await seedConsultee());
    // Another writer (a buyer mid-checkout) holds the first-fit hour's atoms.
    const held = await tryLockSlotBatch(
      [
        {
          consultantProfileId: host.consultantProfileId,
          startsAt,
          endsAt: new Date(startsAt.getTime() + HOUR_MS),
        },
      ],
      60_000,
    );
    expect(held.ok).toBe(true);

    try {
      const result = await allocate({
        eventType: "consultation",
        eventId: request.consultationId,
        mode: "auto",
      });

      expect(result).toEqual(expect.objectContaining({ success: true }));
      const placed = await prisma.appointmentOccurrence.findMany({
        where: { appointment: { consultationId: request.consultationId } },
        select: { startsAt: true },
      });
      expect(placed.map((o) => o.startsAt.getTime())).toEqual([
        startsAt.getTime() + HOUR_MS,
      ]);
      expect(await overlappingOccupyingPairs(host.consultantProfileId)).toBe(0);
    } finally {
      if (held.ok) await unlockSlotInterval(held.grant);
    }
  });
});

describe("availability shrink × allocator", () => {
  it("a shrink committing under the allocator's search refuses with AVAILABILITY_CHANGED", async () => {
    const host = await seedHost();
    const startsAt = futureAt(5, 13);
    await publishOnly(host, {
      startsAt,
      endsAt: new Date(startsAt.getTime() + 2 * HOUR_MS),
    });
    const request = await seedRequest(host, await seedConsultee());
    const paused = gate();
    guardGate.current = paused;

    const allocating = allocate({
      eventType: "consultation",
      eventId: request.consultationId,
      mode: "manual",
      slots: halfHourStarts(startsAt),
    });
    await parkedOrFailed(paused, allocating);
    // The host removes the first hour while the allocation is in flight.
    await publishOnly(host, {
      startsAt: new Date(startsAt.getTime() + HOUR_MS),
      endsAt: new Date(startsAt.getTime() + 2 * HOUR_MS),
    });
    paused.open();

    expect(await allocating).toMatchObject({
      success: false,
      errorCode: "AVAILABILITY_CHANGED",
      httpStatus: 409,
    });
    const placed = await prisma.appointmentOccurrence.count({
      where: { appointment: { consultationId: request.consultationId } },
    });
    expect(placed).toBe(0);
  });
});

describe("consultant-as-client × own allocator", () => {
  it("U's allocator placing U's client at T and U booking expert E at T: U's own atoms let only one commit", async () => {
    const dualU = await seedDualRole();
    await prisma.consulteeProfile.update({
      where: { id: dualU.consulteeProfileId },
      data: { billingStateCode: "29" },
    });
    const expertE = await seedHost();
    await publishEveryHour(expertE);
    const planOfE = await prisma.consultationPlan.create({
      data: {
        title: "E's consultation",
        price: BigInt(100_000),
        consultantProfileId: expertE.consultantProfileId,
        durationInHours: 1,
      },
    });
    const clientRequest = await seedRequest(dualU, await seedConsultee());
    const startsAt = futureAt(6, 10);
    const paused = gate();
    allocatorGate.current = paused;

    const allocating = allocate({
      eventType: "consultation",
      eventId: clientRequest.consultationId,
      mode: "manual",
      slots: halfHourStarts(startsAt),
      override: true,
    });
    await parkedOrFailed(paused, allocating);
    const booking = await handleCheckout(
      {
        appointmentType: "CONSULTATION",
        planId: planOfE.id,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + HOUR_MS).toISOString(),
        paymentGateway: "RAZORPAY",
        clientIdempotencyKey: `u-books-e-${randomUUID()}`,
        consumerStateCode: "29",
      },
      dualU.userId,
    ).then(
      () => "committed" as const,
      (error: unknown) => error,
    );
    paused.open();

    expect(await allocating).toMatchObject({ success: true });
    expect(booking).toBeInstanceOf(Error);
    expect((booking as Error).message).toMatch(
      /being booked|currently booking/i,
    );
    expect(await overlappingOccupyingPairs(dualU.consultantProfileId)).toBe(0);
  }, 30_000);
});
