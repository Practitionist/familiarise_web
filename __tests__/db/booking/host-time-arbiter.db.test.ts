/**
 * Postgres arbitrates an expert's time when the Redis slot batch does not: here
 * every slot batch is granted, so the only refusal left is the write
 * transaction's advisory try-locks. Each pair parks one writer inside its
 * transaction (its atoms taken) and fires the other; the second answers its
 * door's slot-taken 409 at once and the first commits:
 *  - checkout × request-for-approval, on the calendar of an expert who is the
 *    host of one and the requester of the other (both orders);
 *  - checkout × reschedule acceptance on one host (both orders);
 *  - allocator × class creation on one host (both orders);
 *  - checkout × request-for-approval by one learner with two different
 *    experts: the learner's own time is the only thing the two share.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import {
  futureAt,
  gate,
  HOUR_MS,
  overlappingOccupyingPairs,
  seedConsultee,
  seedDualRole,
  seedHost,
  seedOneToOne,
  type SeededConsultee,
  type SeededHost,
} from "./harness";
import {
  consultationCheckout,
  halfHourStarts,
  publishEveryHour,
  seedBuyer,
  seedConsultationPlan,
  seedRequest,
} from "./harness-host";

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
jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/email", () =>
  jest
    .requireActual("../../fixtures/noop-module")
    .noopModule({ success: true }),
);
jest.mock("../../../utils/contentValidation", () =>
  jest.requireActual("../../fixtures/content-validation-stub"),
);
const sessionUser = { current: { id: "" } as Record<string, unknown> };
jest.mock("../../../lib/auth-server", () => ({
  getSession: async () => ({ user: sessionUser.current }),
}));
jest.mock("../../../lib/rate-limit", () =>
  jest.requireActual("./harness-edges").rateLimitMock(),
);

/**
 * The Redis slot tier and the consultee key have lapsed: every batch and every
 * consultee grant is given, renewed and released, so one learner's two
 * bookings reach their transactions together.
 */
jest.mock("../../../utils/appointmentlock", () => {
  const actual = jest.requireActual("../../../utils/appointmentlock");
  const CONSULTEE = "consultee-booking:";
  const granted = (entries: unknown[]) =>
    actual.slotBatchKeys(entries).map((key: string) => ({
      key,
      value: "lapsed",
      ttl: 60_000,
      acquiredAt: Date.now(),
      client: {},
    }));
  return {
    ...actual,
    tryLockSlotBatch: async (entries: unknown[]) => ({
      ok: true,
      grant: granted(entries),
    }),
    lockSlotBatch: async (entries: unknown[]) => granted(entries),
    extendSlotInterval: async () => true,
    unlockSlotInterval: async () => undefined,
    unlockSlotBooking: async () => undefined,
    lockConsulteeBooking: async (userId: string) => ({
      key: `${CONSULTEE}${userId}`,
      value: "lapsed",
      ttl: 60_000,
      acquiredAt: Date.now(),
      client: {},
    }),
    renewConsulteeBooking: async () => undefined,
    unlockConsulteeBooking: async () => undefined,
    extendLock: async (lock: { key: string }, ttl?: number) =>
      lock.key.startsWith(CONSULTEE) ? true : actual.extendLock(lock, ttl),
  };
});

type Gate = ReturnType<typeof gate>;
const parkOnce = async (slot: { current: Gate | null }) => {
  const g = slot.current;
  if (!g) return;
  slot.current = null;
  await g.park();
};

/** Parks the allocator after its try-locks, before the event's advisory lock. */
const allocatorGate = { current: null as Gate | null };
jest.mock("../../../lib/booking/allocation/guards", () => {
  const actual = jest.requireActual("../../../lib/booking/allocation/guards");
  return {
    ...actual,
    guardAllocationInTx: async (...args: unknown[]) => {
      await parkOnce(allocatorGate);
      return actual.guardAllocationInTx(...args);
    },
  };
});
/** Parks a checkout after its try-locks, at the expert's standing read. */
const checkoutGate = { current: null as Gate | null };
jest.mock("../../../lib/booking/expert-standing", () => {
  const actual = jest.requireActual("../../../lib/booking/expert-standing");
  return {
    ...actual,
    assertPlanExpertStandsInTx: async (...args: unknown[]) => {
      await parkOnce(checkoutGate);
      return actual.assertPlanExpertStandsInTx(...args);
    },
  };
});
/** Parks a request-for-approval after its try-locks, at the cap read. */
const requestGate = { current: null as Gate | null };
jest.mock("../../../lib/booking/request-caps", () => {
  const actual = jest.requireActual("../../../lib/booking/request-caps");
  return {
    ...actual,
    capacityRefusal: async (...args: unknown[]) => {
      await parkOnce(requestGate);
      return actual.capacityRefusal(...args);
    },
  };
});
/** Parks a class creation after its try-locks, at the host's calendar check. */
const classGate = { current: null as Gate | null };
jest.mock("../../../lib/collaborators/availability", () => {
  const actual = jest.requireActual("../../../lib/collaborators/availability");
  return {
    ...actual,
    assertConsultantAvailableForWindows: async (...args: unknown[]) => {
      await parkOnce(classGate);
      return actual.assertConsultantAvailableForWindows(...args);
    },
  };
});

import { allocate } from "../../../lib/booking/allocation";
import { acceptProposal } from "../../../lib/booking/reschedule-respond";
import { handleCheckout } from "../../../lib/payments/checkout";
import { withAppointmentLock } from "../../../utils/appointmentlock";
import { POST as createClass } from "../../../app/api/bookings/classes/crud-with-plan/route";
import { POST as requestForApproval } from "../../../app/api/scheduling/request-for-approval/route";

/** Waits for a parked racer; one that ends first fails the test with its answer. */
async function parked(paused: Gate, racing: Promise<unknown>) {
  await Promise.race([
    paused.arrived,
    racing.then(
      (result) => {
        throw new Error(`finished before parking: ${JSON.stringify(result)}`);
      },
      (error: unknown) => {
        throw new Error(`failed before parking: ${String(error)}`);
      },
    ),
  ]);
}

const settled = <T>(racing: Promise<T>) =>
  racing.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

/** Live rows of `host` that overlap [startsAt, startsAt + 1h). */
function occupyingAt(host: SeededHost, startsAt: Date) {
  return prisma.appointmentOccurrence.count({
    where: {
      consultantProfileId: host.consultantProfileId,
      deletedAt: null,
      completionStatus: "SCHEDULED",
      startsAt: { lt: new Date(startsAt.getTime() + HOUR_MS) },
      endsAt: { gt: startsAt },
    },
  });
}

function checkout(planId: string, startsAt: Date, buyer: SeededConsultee) {
  return handleCheckout(
    consultationCheckout(planId, startsAt, `arbiter-${randomUUID()}`),
    buyer.userId,
  );
}

describe("checkout × request-for-approval on an expert who hosts one and requests the other", () => {
  /** `expert` sells a 1:1 by instant checkout and asks `other` for a session as a client. */
  async function seedPair() {
    const expert = await seedDualRole();
    await publishEveryHour(expert);
    const expertPlan = await seedConsultationPlan(expert, "Arbiter checkout");
    const other = await seedHost();
    await publishEveryHour(other);
    await prisma.consultantProfile.update({
      where: { id: other.consultantProfileId },
      data: { acceptingRequests: true, bookingMode: "REQUEST" },
    });
    const otherPlan = await seedConsultationPlan(other, "Arbiter request");
    return { expert, expertPlan, other, otherPlan, buyer: await seedBuyer() };
  }

  async function request(
    expert: Awaited<ReturnType<typeof seedDualRole>>,
    other: SeededHost,
    planId: string,
    startsAt: Date,
  ) {
    const row = await prisma.availabilityWindowCustom.findFirstOrThrow({
      where: { consultantProfileId: other.consultantProfileId },
      select: { id: true },
    });
    sessionUser.current = {
      id: expert.userId,
      consultantProfileId: expert.consultantProfileId,
    };
    return requestForApproval(
      new NextRequest("https://x.test/api/scheduling/request-for-approval", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({
          consultantProfileId: other.consultantProfileId,
          consultationPlanId: planId,
          availabilityWindowCustomId: row.id,
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + HOUR_MS).toISOString(),
        }),
      }),
    );
  }

  it("the request holding the expert's time first: the checkout is refused, unwritten", async () => {
    const { expert, expertPlan, other, otherPlan, buyer } = await seedPair();
    const startsAt = futureAt(8, 10);

    const paused = gate();
    requestGate.current = paused;
    const requesting = request(expert, other, otherPlan.id, startsAt);
    await parked(paused, requesting);
    const bought = await settled(checkout(expertPlan.id, startsAt, buyer));
    paused.open();

    expect((await requesting).status).toBe(201);
    expect(bought.ok).toBe(false);
    expect(String(!bought.ok && bought.error)).toMatch(/already booked/i);
    expect(await occupyingAt(expert, startsAt)).toBe(0);
    expect(await occupyingAt(other, startsAt)).toBe(1);
  }, 45_000);

  it("the checkout holding the expert's time first: the request is refused 409 SLOT_TAKEN", async () => {
    const { expert, expertPlan, other, otherPlan, buyer } = await seedPair();
    const startsAt = futureAt(8, 12);

    const paused = gate();
    checkoutGate.current = paused;
    const buying = checkout(expertPlan.id, startsAt, buyer);
    await parked(paused, buying);
    const requested = await request(expert, other, otherPlan.id, startsAt);
    paused.open();

    await expect(buying).resolves.toBeDefined();
    expect(requested.status).toBe(409);
    expect(await requested.json()).toMatchObject({ code: "SLOT_TAKEN" });
    expect(await occupyingAt(expert, startsAt)).toBe(1);
    expect(await occupyingAt(other, startsAt)).toBe(0);
  }, 45_000);
});

describe("checkout × reschedule acceptance on one host", () => {
  /** A paid consultation released for a move, with the learner's proposal of `newStart` open. */
  async function seedOpenProposal(host: SeededHost, newStart: Date) {
    const learner = await seedConsultee();
    const oldStart = futureAt(9, 6);
    const booking = await seedOneToOne(
      "consultation",
      host,
      learner,
      { startsAt: oldStart, endsAt: new Date(oldStart.getTime() + HOUR_MS) },
      {
        status: "APPROVED",
        isTentative: true,
        completionStatus: "RESCHEDULED",
        payment: { status: "SUCCEEDED", expiresAt: null },
      },
    );
    if (!booking.consultationId) throw new Error("seed made no consultation");
    const proposal = await prisma.rescheduleRequest.create({
      data: {
        appointmentId: booking.appointmentId,
        initiatorRole: "CONSULTEE",
        initiatedById: learner.userId,
        releasedOccurrenceIds: [booking.occurrenceId],
        originStatus: "APPROVED",
        expiresAt: new Date(Date.now() + 24 * HOUR_MS),
        openForAppointmentId: booking.appointmentId,
        proposedTimes: {
          create: halfHourStarts(newStart).map((iso) => ({
            startsAt: new Date(iso),
            endsAt: new Date(new Date(iso).getTime() + HOUR_MS / 2),
            proposedById: learner.userId,
          })),
        },
      },
    });
    return {
      proposalId: proposal.id,
      appointmentId: booking.appointmentId,
      consultationId: booking.consultationId,
    };
  }

  const accept = (
    host: SeededHost,
    move: Awaited<ReturnType<typeof seedOpenProposal>>,
  ) =>
    withAppointmentLock(move.appointmentId, (lock) =>
      acceptProposal({
        rescheduleRequestId: move.proposalId,
        eventType: "consultation",
        eventId: move.consultationId,
        resolvedById: host.userId,
        heldAppointmentLock: lock,
      }),
    );

  const proposalStatus = async (id: string) =>
    (await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id } }))
      .status;

  it("the acceptance holding the time first: the checkout is refused, unwritten", async () => {
    const host = await seedHost();
    await publishEveryHour(host);
    const plan = await seedConsultationPlan(host, "Arbiter move");
    const newStart = futureAt(9, 10);
    const move = await seedOpenProposal(host, newStart);
    const buyer = await seedBuyer();

    const paused = gate();
    allocatorGate.current = paused;
    const accepting = accept(host, move);
    await parked(paused, accepting);
    const bought = await settled(checkout(plan.id, newStart, buyer));
    paused.open();

    expect(await accepting).toEqual({ done: true });
    expect(bought.ok).toBe(false);
    expect(String(!bought.ok && bought.error)).toMatch(/already booked/i);
    expect(await proposalStatus(move.proposalId)).toBe("ACCEPTED");
    expect(await occupyingAt(host, newStart)).toBe(1);
    expect(await overlappingOccupyingPairs(host.consultantProfileId)).toBe(0);
  }, 45_000);

  it("the checkout holding the time first: the acceptance answers TIMES_TAKEN and stays open", async () => {
    const host = await seedHost();
    await publishEveryHour(host);
    const plan = await seedConsultationPlan(host, "Arbiter move");
    const newStart = futureAt(9, 12);
    const move = await seedOpenProposal(host, newStart);
    const buyer = await seedBuyer();

    const paused = gate();
    checkoutGate.current = paused;
    const buying = checkout(plan.id, newStart, buyer);
    await parked(paused, buying);
    const accepted = await accept(host, move);
    paused.open();

    await expect(buying).resolves.toBeDefined();
    expect(accepted).toEqual({ done: false, reason: "TIMES_TAKEN" });
    expect(await proposalStatus(move.proposalId)).toBe("PENDING_REVIEW");
    expect(await occupyingAt(host, newStart)).toBe(1);
  }, 45_000);
});

describe("allocator × class creation on one host", () => {
  function create(host: SeededHost, startsAt: Date) {
    sessionUser.current = { id: host.userId };
    return createClass(
      new NextRequest("https://x.test/api/bookings/classes/crud-with-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consultantProfileId: host.consultantProfileId,
          title: `Arbiter class ${randomUUID().slice(0, 8)}`,
          description:
            "A weekly class whose first session races an allocation for the host's time.",
          durationInMonths: 1,
          price: 50_000,
          maxParticipants: 10,
          level: "BEGINNER",
          learningOutcomes: ["Understand how host time is arbitrated"],
          topics: ["Scheduling"],
          sessionsPerWeek: 1,
          sessionDurationInHours: 1,
          classContents: [
            {
              title: "Session one",
              description:
                "The first session of the series, covering the basics.",
              hoursAllotted: 1,
            },
          ],
          status: "SCHEDULED",
          startDate: startsAt.toISOString(),
        }),
      }),
    );
  }

  const scheduledClasses = (host: SeededHost) =>
    prisma.class.count({
      where: {
        status: "SCHEDULED",
        classPlan: { consultantProfileId: host.consultantProfileId },
      },
    });

  it("the allocator holding the first session's time: the class is refused 409, uncreated", async () => {
    const host = await seedHost();
    await publishEveryHour(host);
    const startsAt = futureAt(10, 10);
    const request = await seedRequest(host, await seedConsultee());

    const paused = gate();
    allocatorGate.current = paused;
    const allocating = allocate({
      eventType: "consultation",
      eventId: request.consultationId,
      mode: "manual",
      slots: halfHourStarts(startsAt),
    });
    await parked(paused, allocating);
    const created = await create(host, startsAt);
    paused.open();

    expect(await allocating).toMatchObject({ success: true });
    expect(created.status).toBe(409);
    expect(await scheduledClasses(host)).toBe(0);
    expect(await overlappingOccupyingPairs(host.consultantProfileId)).toBe(0);
  }, 45_000);

  it("the class creation holding the time first: the allocator answers TIMES_TAKEN", async () => {
    const host = await seedHost();
    await publishEveryHour(host);
    const startsAt = futureAt(10, 12);
    const request = await seedRequest(host, await seedConsultee());

    const paused = gate();
    classGate.current = paused;
    const creating = create(host, startsAt);
    await parked(paused, creating);
    const allocation = await allocate({
      eventType: "consultation",
      eventId: request.consultationId,
      mode: "manual",
      slots: halfHourStarts(startsAt),
    });
    paused.open();

    expect((await creating).status).toBeLessThan(300);
    expect(allocation).toMatchObject({
      success: false,
      errorCode: "TIMES_TAKEN",
      httpStatus: 409,
    });
    expect(await scheduledClasses(host)).toBe(1);
    expect(await overlappingOccupyingPairs(host.consultantProfileId)).toBe(0);
  }, 45_000);
});

describe("one learner × two experts at one time", () => {
  it("a checkout holding the learner's time: their request to another expert is refused as their own clash", async () => {
    const hostA = await seedHost();
    await publishEveryHour(hostA);
    const planA = await seedConsultationPlan(hostA, "Arbiter learner checkout");
    const hostB = await seedHost();
    await publishEveryHour(hostB);
    await prisma.consultantProfile.update({
      where: { id: hostB.consultantProfileId },
      data: { acceptingRequests: true, bookingMode: "REQUEST" },
    });
    const planB = await seedConsultationPlan(hostB, "Arbiter learner request");
    const learner = await seedBuyer();
    const startsAt = futureAt(11, 10);
    const rowB = await prisma.availabilityWindowCustom.findFirstOrThrow({
      where: { consultantProfileId: hostB.consultantProfileId },
      select: { id: true },
    });

    const paused = gate();
    checkoutGate.current = paused;
    const buying = checkout(planA.id, startsAt, learner);
    await parked(paused, buying);
    sessionUser.current = { id: learner.userId };
    const requested = await requestForApproval(
      new NextRequest("https://x.test/api/scheduling/request-for-approval", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({
          consultantProfileId: hostB.consultantProfileId,
          consultationPlanId: planB.id,
          availabilityWindowCustomId: rowB.id,
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + HOUR_MS).toISOString(),
        }),
      }),
    );
    paused.open();

    await expect(buying).resolves.toBeDefined();
    expect(requested.status).toBe(409);
    const body = await requested.json();
    expect(body.code).toBe("SLOT_TAKEN");
    expect(body.error).toMatch(/already have a session/i);
    expect(await occupyingAt(hostA, startsAt)).toBe(1);
    expect(await occupyingAt(hostB, startsAt)).toBe(0);
  }, 45_000);
});
