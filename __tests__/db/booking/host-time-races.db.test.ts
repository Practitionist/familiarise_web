/**
 * Host-time writers racing the allocator and the request door on one expert's
 * time. Each pair parks one writer inside its transaction (its atoms held) and
 * fires the other; the second is refused with a typed 409 and the database
 * never holds two live commitments of the expert at once:
 *  - allocator × webinar publish (both orders);
 *  - request-for-approval × webinar publish (both orders);
 *  - co-host accept × allocator on the co-host's own calendar (both orders);
 *  - a reschedule hold × a webinar published at the original time.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "../../../lib/prisma";
import {
  futureAt,
  gate,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
  type SeededHost,
} from "./harness";
import { halfHourStarts, publishEveryHour, seedRequest } from "./harness-host";

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
jest.mock("../../../lib/email", () => {
  const noop = jest.fn(async () => ({ success: true }));
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});
jest.mock("../../../utils/contentValidation", () =>
  jest.requireActual("../../fixtures/content-validation-stub"),
);
const sessionUser = { current: { id: "" } as Record<string, unknown> };
jest.mock("../../../lib/auth-server", () => ({
  getSession: async () => ({ user: sessionUser.current }),
}));
jest.mock("../../../lib/rate-limit", () => ({
  ...jest.requireActual("../../../lib/rate-limit"),
  applyRateLimit: async () => null,
}));

/** Parks the allocator at the top of its write transaction, slot batch held. */
const allocatorGate = { current: null as ReturnType<typeof gate> | null };
jest.mock("../../../lib/booking/allocation/guards", () => {
  const actual = jest.requireActual("../../../lib/booking/allocation/guards");
  return {
    ...actual,
    guardAllocationInTx: async (...args: unknown[]) => {
      const g = allocatorGate.current;
      if (g) {
        allocatorGate.current = null;
        await g.park();
      }
      return actual.guardAllocationInTx(...args);
    },
  };
});
/** Parks a webinar publish inside its transaction, host atoms held. */
const publishGate = { current: null as ReturnType<typeof gate> | null };
jest.mock("../../../lib/collaborators/availability", () => {
  const actual = jest.requireActual("../../../lib/collaborators/availability");
  return {
    ...actual,
    assertConsultantAvailableForWindows: async (...args: unknown[]) => {
      const g = publishGate.current;
      if (g) {
        publishGate.current = null;
        await g.park();
      }
      return actual.assertConsultantAvailableForWindows(...args);
    },
  };
});
/** Parks a request-for-approval inside its transaction, atoms held. */
const requestGate = { current: null as ReturnType<typeof gate> | null };
jest.mock("../../../lib/booking/request-caps", () => {
  const actual = jest.requireActual("../../../lib/booking/request-caps");
  return {
    ...actual,
    capacityRefusal: async (...args: unknown[]) => {
      const g = requestGate.current;
      if (g) {
        requestGate.current = null;
        await g.park();
      }
      return actual.capacityRefusal(...args);
    },
  };
});

import { allocate } from "../../../lib/booking/allocation";
import { respondToInvitation } from "../../../lib/collaborators/service";
import { PATCH as patchWebinar } from "../../../app/api/bookings/webinars/crud-with-plan/route";
import { POST as requestForApproval } from "../../../app/api/scheduling/request-for-approval/route";

/** Waits for a parked racer; one that ends first fails the test with its answer. */
async function parked(
  paused: ReturnType<typeof gate>,
  racing: Promise<unknown>,
) {
  await Promise.race([
    paused.arrived,
    racing.then((result) => {
      throw new Error(`finished before parking: ${JSON.stringify(result)}`);
    }),
  ]);
}

/**
 * No two live commitments of one expert overlap: rows they host (a DRAFT event
 * is not live) and ACCEPTED co-host seats on live events.
 */
async function liveOverlapPairs(host: SeededHost): Promise<number> {
  const [{ pairs }] = await prisma.$queryRaw<{ pairs: number }[]>(Prisma.sql`
    WITH live AS (
      SELECT o.id, o."startsAt", o."endsAt"
      FROM "AppointmentOccurrence" o
      JOIN "Appointment" a ON a.id = o."appointmentId"
      LEFT JOIN "Webinar" w ON w.id = a."webinarId"
      LEFT JOIN "WebinarPlan" wp ON wp.id = w."webinarPlanId"
      WHERE o."deletedAt" IS NULL AND o."hostCancelledAt" IS NULL
        AND o."completionStatus" <> 'CANCELLED'
        AND (w.id IS NULL OR w.status <> 'DRAFT')
        AND (o."consultantProfileId" = ${host.consultantProfileId}
             OR EXISTS (SELECT 1 FROM "Collaborator" c
                        WHERE c."webinarPlanId" = wp.id
                          AND c."consultantProfileId" = ${host.consultantProfileId}
                          AND c.status = 'ACCEPTED'))
    )
    SELECT count(*)::int AS pairs FROM live a JOIN live b
      ON a.id < b.id AND tstzrange(a."startsAt", a."endsAt") && tstzrange(b."startsAt", b."endsAt")`);
  return pairs;
}

/** A webinar of `host` at `startsAt`, DRAFT (tentative row) or SCHEDULED. */
async function seedHostWebinar(
  host: SeededHost,
  startsAt: Date,
  status: "DRAFT" | "SCHEDULED",
) {
  const plan = await prisma.webinarPlan.create({
    data: {
      title: `Race webinar ${randomUUID().slice(0, 8)}`,
      price: BigInt(50_000),
      maxParticipants: 20,
      durationInHours: 1,
      consultantProfileId: host.consultantProfileId,
    },
  });
  const webinar = await prisma.webinar.create({
    data: { webinarPlanId: plan.id, status, maxParticipants: 20 },
  });
  const appointment = await prisma.appointment.create({
    data: { appointmentType: "WEBINAR", webinarId: webinar.id },
  });
  await prisma.appointmentOccurrence.create({
    data: {
      appointmentId: appointment.id,
      ordinal: 1,
      startsAt,
      endsAt: new Date(startsAt.getTime() + HOUR_MS),
      isTentative: status === "DRAFT",
      consultantProfileId: host.consultantProfileId,
    },
  });
  await prisma.appointmentParticipant.create({
    data: {
      appointmentId: appointment.id,
      userId: host.userId,
      role: "CONSULTANT",
      status: "CONFIRMED",
    },
  });
  return { planId: plan.id, webinarId: webinar.id };
}

function publish(host: SeededHost, w: { planId: string; webinarId: string }) {
  sessionUser.current = { id: host.userId };
  return patchWebinar(
    new NextRequest("https://x.test/api/bookings/webinars/crud-with-plan", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: w.planId,
        webinarId: w.webinarId,
        status: "SCHEDULED",
      }),
    }),
  );
}

async function webinarStatus(webinarId: string) {
  return (await prisma.webinar.findUniqueOrThrow({ where: { id: webinarId } }))
    .status;
}

async function placedCount(consultationId: string) {
  return prisma.appointmentOccurrence.count({
    where: { appointment: { consultationId }, deletedAt: null },
  });
}

describe("allocator × webinar publish", () => {
  it("the allocator holding the time first: the publish is refused 409", async () => {
    const host = await seedHost();
    await publishEveryHour(host);
    const startsAt = futureAt(5, 10);
    const webinar = await seedHostWebinar(host, startsAt, "DRAFT");
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
    const published = await publish(host, webinar);
    paused.open();

    expect(await allocating).toMatchObject({ success: true });
    expect(published.status).toBe(409);
    expect(await webinarStatus(webinar.webinarId)).toBe("DRAFT");
    expect(await liveOverlapPairs(host)).toBe(0);
  }, 45_000);

  it("the publish holding the time first: the allocator answers TIMES_TAKEN", async () => {
    const host = await seedHost();
    await publishEveryHour(host);
    const startsAt = futureAt(5, 12);
    const webinar = await seedHostWebinar(host, startsAt, "DRAFT");
    const request = await seedRequest(host, await seedConsultee());

    const paused = gate();
    publishGate.current = paused;
    const publishing = publish(host, webinar);
    await parked(paused, publishing);
    const allocation = await allocate({
      eventType: "consultation",
      eventId: request.consultationId,
      mode: "manual",
      slots: halfHourStarts(startsAt),
    });
    paused.open();

    expect((await publishing).status).toBe(200);
    expect(allocation).toMatchObject({
      success: false,
      errorCode: "TIMES_TAKEN",
      httpStatus: 409,
    });
    expect(await placedCount(request.consultationId)).toBe(0);
    expect(await webinarStatus(webinar.webinarId)).toBe("SCHEDULED");
    expect(await liveOverlapPairs(host)).toBe(0);
  }, 45_000);
});

describe("request-for-approval × webinar publish", () => {
  async function seedRequestable(host: SeededHost) {
    await publishEveryHour(host);
    await prisma.consultantProfile.update({
      where: { id: host.consultantProfileId },
      data: { acceptingRequests: true, bookingMode: "REQUEST" },
    });
    const plan = await prisma.consultationPlan.create({
      data: {
        title: "Requestable consultation",
        price: BigInt(100_000),
        consultantProfileId: host.consultantProfileId,
        durationInHours: 1,
      },
    });
    return plan;
  }

  async function request(
    host: SeededHost,
    planId: string,
    consulteeUserId: string,
    startsAt: Date,
  ) {
    const rowId = (
      await prisma.availabilityWindowCustom.findFirstOrThrow({
        where: { consultantProfileId: host.consultantProfileId },
        select: { id: true },
      })
    ).id;
    sessionUser.current = { id: consulteeUserId };
    return requestForApproval(
      new NextRequest("https://x.test/api/scheduling/request-for-approval", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({
          consultantProfileId: host.consultantProfileId,
          consultationPlanId: planId,
          availabilityWindowCustomId: rowId,
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + HOUR_MS).toISOString(),
        }),
      }),
    );
  }

  it("the publish holding the time first: the request is refused 409, unwritten", async () => {
    const host = await seedHost();
    const plan = await seedRequestable(host);
    const startsAt = futureAt(6, 10);
    const webinar = await seedHostWebinar(host, startsAt, "DRAFT");
    const consultee = await seedConsultee();

    const paused = gate();
    publishGate.current = paused;
    const publishing = publish(host, webinar);
    await parked(paused, publishing);
    const requested = await request(host, plan.id, consultee.userId, startsAt);
    paused.open();

    expect((await publishing).status).toBe(200);
    expect(requested.status).toBe(409);
    expect(
      await prisma.consultation.count({
        where: { requestedById: consultee.consulteeProfileId },
      }),
    ).toBe(0);
    expect(await liveOverlapPairs(host)).toBe(0);
  }, 45_000);

  it("the request holding the time first: the publish is refused 409", async () => {
    const host = await seedHost();
    const plan = await seedRequestable(host);
    const startsAt = futureAt(6, 12);
    const webinar = await seedHostWebinar(host, startsAt, "DRAFT");
    const consultee = await seedConsultee();

    const paused = gate();
    requestGate.current = paused;
    const requesting = request(host, plan.id, consultee.userId, startsAt);
    await parked(paused, requesting);
    const published = await publish(host, webinar);
    paused.open();

    expect((await requesting).status).toBe(201);
    expect(published.status).toBe(409);
    expect(await webinarStatus(webinar.webinarId)).toBe("DRAFT");
    expect(await liveOverlapPairs(host)).toBe(0);
  }, 45_000);
});

describe("co-host accept × allocator on the co-host's calendar", () => {
  async function seedInvite(cohost: SeededHost, startsAt: Date) {
    const owner = await seedHost();
    const webinar = await seedHostWebinar(owner, startsAt, "SCHEDULED");
    await prisma.consultantProfile.update({
      where: { id: cohost.consultantProfileId },
      data: { verificationStatus: "VERIFIED" },
    });
    const invite = await prisma.collaborator.create({
      data: {
        webinarPlanId: webinar.planId,
        consultantProfileId: cohost.consultantProfileId,
        collaboratorType: "WEBINAR",
        status: "PENDING",
        role: "CO_HOST",
        tier: "PRESENTER",
        revenueShareBps: 1_000,
      },
    });
    return { webinar, inviteId: invite.id };
  }

  it("the allocator holding the co-host's time first: the accept is refused 409", async () => {
    const cohost = await seedHost();
    await publishEveryHour(cohost);
    const startsAt = futureAt(7, 10);
    const { inviteId } = await seedInvite(cohost, startsAt);
    const request = await seedRequest(cohost, await seedConsultee());

    const paused = gate();
    allocatorGate.current = paused;
    const allocating = allocate({
      eventType: "consultation",
      eventId: request.consultationId,
      mode: "manual",
      slots: halfHourStarts(startsAt),
    });
    await parked(paused, allocating);
    const accepted = await respondToInvitation(
      "webinar",
      inviteId,
      cohost.consultantProfileId,
      "ACCEPTED",
    ).then(
      () => "accepted" as const,
      (error: unknown) => error,
    );
    paused.open();

    expect(await allocating).toMatchObject({ success: true });
    expect(accepted).toBeInstanceOf(Error);
    expect((accepted as Error & { httpStatus?: number }).httpStatus).toBe(409);
    expect(
      (await prisma.collaborator.findUniqueOrThrow({ where: { id: inviteId } }))
        .status,
    ).toBe("PENDING");
    expect(await liveOverlapPairs(cohost)).toBe(0);
  }, 45_000);

  it("the accept committed first: the allocator refuses the co-host's taken time", async () => {
    const cohost = await seedHost();
    await publishEveryHour(cohost);
    const startsAt = futureAt(7, 12);
    const { inviteId } = await seedInvite(cohost, startsAt);
    const request = await seedRequest(cohost, await seedConsultee());

    await respondToInvitation(
      "webinar",
      inviteId,
      cohost.consultantProfileId,
      "ACCEPTED",
    );
    const allocation = await allocate({
      eventType: "consultation",
      eventId: request.consultationId,
      mode: "manual",
      slots: halfHourStarts(startsAt),
    });

    expect(allocation.success).toBe(false);
    expect(allocation.httpStatus).toBeGreaterThanOrEqual(400);
    expect(allocation.httpStatus).toBeLessThan(500);
    expect(await placedCount(request.consultationId)).toBe(0);
    expect(await liveOverlapPairs(cohost)).toBe(0);
  }, 45_000);
});

describe("reschedule hold × webinar at the original time", () => {
  it("a publish onto the time a pending reschedule can restore is refused 409", async () => {
    const host = await seedHost();
    await publishEveryHour(host);
    const startsAt = futureAt(8, 10);
    // The original session, released while its reschedule proposal is open.
    await seedOneToOne(
      "consultation",
      host,
      await seedConsultee(),
      { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
      {
        status: "APPROVED",
        isTentative: true,
        completionStatus: "RESCHEDULED",
        payment: { status: "SUCCEEDED", expiresAt: null },
      },
    );
    const webinar = await seedHostWebinar(host, startsAt, "DRAFT");

    const published = await publish(host, webinar);

    expect(published.status).toBe(409);
    expect(await webinarStatus(webinar.webinarId)).toBe("DRAFT");
  }, 45_000);
});
