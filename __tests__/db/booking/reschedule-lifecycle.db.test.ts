/**
 * The 1:1 reschedule machine through its real doors: "any time works" opens a
 * preference-only request that holds the one-open reservation and records the
 * parent's origin, so a second release waits, expiry and withdrawal restore
 * exactly what moved, and a restored request costs no reschedule.
 */
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import { HOUR_MS, seedConsultee, seedHost, seedOneToOne } from "./harness";

const sessionUser = { current: null as null | Record<string, unknown> };
jest.mock("../../../lib/auth-helpers", () => ({
  ...jest.requireActual("../../../lib/auth-helpers"),
  requireApiAuth: async () => ({ session: { user: sessionUser.current } }),
  isPrivileged: () => false,
}));
jest.mock("../../../lib/rate-limit", () => ({
  ...jest.requireActual("../../../lib/rate-limit"),
  applyRateLimit: async () => null,
}));
jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/novu/service", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);

const poison = new Set<string>();
jest.mock("../../../lib/booking/reschedule-restore", () => {
  const actual: typeof import("../../../lib/booking/reschedule-restore") =
    jest.requireActual("../../../lib/booking/reschedule-restore");
  return {
    ...actual,
    restoreRescheduledBooking: async (
      ...args: Parameters<typeof actual.restoreRescheduledBooking>
    ) => {
      if (poison.has(args[1].id)) throw new Error("poison row");
      return actual.restoreRescheduledBooking(...args);
    },
  };
});

import { POST as reschedule } from "../../../app/api/appointments/[appointmentId]/reschedule/route";
import { POST as withdraw } from "../../../app/api/appointments/[appointmentId]/reschedule/withdraw/route";
import { expireRescheduleProposals } from "../../../scripts/appointments/expire-reschedule-proposals";
import { RELEASE_ONE_WEEK_MESSAGE } from "../../../lib/booking/release-weeks";

const hoursAhead = (hours: number) =>
  new Date(Math.ceil((Date.now() + hours * HOUR_MS) / HOUR_MS) * HOUR_MS);

const post = (
  handler: typeof reschedule,
  path: string,
  appointmentId: string,
  body?: unknown,
) =>
  handler(
    new NextRequest(
      `http://localhost/api/appointments/${appointmentId}${path}`,
      {
        method: "POST",
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
              headers: { "Content-Type": "application/json" },
            }),
      },
    ),
    { params: Promise.resolve({ appointmentId }) },
  );

async function paidConsultation(startsAt = hoursAhead(24 * 5)) {
  const host = await seedHost();
  const buyer = await seedConsultee();
  const booking = await seedOneToOne(
    "consultation",
    host,
    buyer,
    { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
    {
      status: "APPROVED",
      isTentative: false,
      payment: { status: "SUCCEEDED", expiresAt: null },
    },
  );
  sessionUser.current = {
    id: buyer.userId,
    role: "CONSULTEE",
    consulteeProfileId: buyer.consulteeProfileId,
    consultantProfileId: null,
    name: "Buyer",
  };
  return { host, buyer, booking, startsAt };
}

async function bookingState(appointmentId: string, consultationId: string) {
  const [consultation, occurrences, requests] = await Promise.all([
    prisma.consultation.findUniqueOrThrow({
      where: { id: consultationId },
      select: { status: true },
    }),
    prisma.appointmentOccurrence.findMany({
      where: { appointmentId, deletedAt: null },
      select: { completionStatus: true, isTentative: true },
    }),
    prisma.rescheduleRequest.findMany({
      where: { appointmentId },
      select: {
        status: true,
        openForAppointmentId: true,
        originStatus: true,
        _count: { select: { proposedTimes: true } },
      },
    }),
  ]);
  return { status: consultation.status, occurrences, requests };
}

describe("1:1 reschedule lifecycle on the database", () => {
  it("'any time works' opens a preference-only request that the expiry sweep restores", async () => {
    const { booking } = await paidConsultation();
    const res = await post(reschedule, "/reschedule", booking.appointmentId);
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("RELEASED");

    const released = await bookingState(
      booking.appointmentId,
      booking.consultationId!,
    );
    expect(released.status).toBe("PENDING");
    expect(released.occurrences).toEqual([
      { completionStatus: "RESCHEDULED", isTentative: true },
    ]);
    expect(released.requests).toEqual([
      {
        status: "PENDING_REVIEW",
        openForAppointmentId: booking.appointmentId,
        originStatus: "APPROVED",
        _count: { proposedTimes: 0 },
      },
    ]);

    await prisma.rescheduleRequest.updateMany({
      where: { appointmentId: booking.appointmentId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const run = await expireRescheduleProposals({ maxPerRun: 25 });
    expect(run.errors).toEqual([]);

    const restored = await bookingState(
      booking.appointmentId,
      booking.consultationId!,
    );
    expect(restored.status).toBe("APPROVED");
    expect(restored.occurrences).toEqual([
      { completionStatus: "SCHEDULED", isTentative: false },
    ]);
    expect(restored.requests[0]).toMatchObject({
      status: "EXPIRED",
      openForAppointmentId: null,
    });
    const expired = await prisma.rescheduleRequest.findFirstOrThrow({
      where: { appointmentId: booking.appointmentId },
      select: { restoredAt: true },
    });
    expect(expired.restoredAt).not.toBeNull();
  });

  it("two releases at once: one opens the request, the other is refused and nothing moves twice", async () => {
    const { booking } = await paidConsultation();
    const answers = await Promise.all([
      post(reschedule, "/reschedule", booking.appointmentId),
      post(reschedule, "/reschedule", booking.appointmentId),
    ]);
    const statuses = answers.map((r) => r.status).sort();
    expect(statuses[0]).toBe(200);
    expect([409, 423]).toContain(statuses[1]);

    const state = await bookingState(
      booking.appointmentId,
      booking.consultationId!,
    );
    expect(state.requests).toHaveLength(1);
    const releases = await prisma.bookingStatusHistory.count({
      where: {
        appointmentId: booking.appointmentId,
        entity: "OCCURRENCE",
        toStatus: "RESCHEDULED",
      },
    });
    expect(releases).toBe(1);

    // A later second release is refused outright while the first is open.
    const again = await post(reschedule, "/reschedule", booking.appointmentId);
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe("RESCHEDULE_ALREADY_OPEN");
  });

  it("restores from the recorded origin when no history row is near the request", async () => {
    const { booking } = await paidConsultation();
    expect(
      (await post(reschedule, "/reschedule", booking.appointmentId)).status,
    ).toBe(200);
    // A slow release: the request row lands a minute after the parent's
    // history row, so a ±5 s timestamp join finds no origin.
    await prisma.rescheduleRequest.updateMany({
      where: { appointmentId: booking.appointmentId },
      data: { createdAt: new Date(Date.now() + 60_000) },
    });

    const res = await post(
      withdraw,
      "/reschedule/withdraw",
      booking.appointmentId,
    );
    expect(res.status).toBe(200);
    const state = await bookingState(
      booking.appointmentId,
      booking.consultationId!,
    );
    expect(state.status).toBe("APPROVED");
    expect(state.occurrences).toEqual([
      { completionStatus: "SCHEDULED", isTentative: false },
    ]);
  });

  it("a withdrawn or expired-and-restored request costs no reschedule", async () => {
    const { booking } = await paidConsultation();
    for (let i = 0; i < 3; i++) {
      const res = await post(reschedule, "/reschedule", booking.appointmentId);
      expect(res.status).toBe(200);
      if (i % 2 === 0) {
        await post(withdraw, "/reschedule/withdraw", booking.appointmentId);
      } else {
        await prisma.rescheduleRequest.updateMany({
          where: {
            appointmentId: booking.appointmentId,
            openForAppointmentId: { not: null },
          },
          data: { expiresAt: new Date(Date.now() - 60_000) },
        });
        await expireRescheduleProposals({ maxPerRun: 25 });
      }
    }
    // Three requests, none of which moved the session: the fourth is allowed.
    const fourth = await post(reschedule, "/reschedule", booking.appointmentId);
    expect(fourth.status).toBe(200);
  });

  it("a new time inside 24 hours waits for acceptance; under the acceptance lead, or with a live pay link, it is refused", async () => {
    const hourAt = (at: Date) =>
      [0, 1].map((half) => ({
        startsAt: new Date(at.getTime() + half * 30 * 60_000).toISOString(),
        endsAt: new Date(at.getTime() + (half + 1) * 30 * 60_000).toISOString(),
      }));

    // A time 3 hours away is a request the other side answers, never a move.
    const { booking } = await paidConsultation();
    const soon = await post(reschedule, "/reschedule", booking.appointmentId, {
      proposedSlots: hourAt(hoursAhead(3)),
    });
    expect(soon.status).toBe(200);
    expect(await soon.json()).toMatchObject({
      autoConfirmed: false,
      autoConfirmReason: "NEEDS_ACCEPTANCE",
      outcome: "AWAITING_ANSWER",
    });
    const waiting = await bookingState(
      booking.appointmentId,
      booking.consultationId!,
    );
    expect(waiting.requests).toEqual([
      expect.objectContaining({
        status: "PENDING_REVIEW",
        openForAppointmentId: booking.appointmentId,
      }),
    ]);
    expect(waiting.occurrences).toEqual([
      { completionStatus: "RESCHEDULED", isTentative: true },
    ]);

    // A session itself inside 24 hours: the proposal lapses 15 minutes before it.
    const near = await paidConsultation(hoursAhead(6));
    const nearRes = await post(
      reschedule,
      "/reschedule",
      near.booking.appointmentId,
      { proposedSlots: hourAt(hoursAhead(30)) },
    );
    expect(nearRes.status).toBe(200);
    const nearRequest = await prisma.rescheduleRequest.findFirstOrThrow({
      where: { appointmentId: near.booking.appointmentId },
      select: { status: true, expiresAt: true },
    });
    expect(nearRequest.status).toBe("PENDING_REVIEW");
    expect(nearRequest.expiresAt?.getTime()).toBe(
      near.startsAt.getTime() - 15 * 60_000,
    );

    // A paid booking's proposed time still needs the 15-minute acceptance lead.
    const late = await paidConsultation();
    const tooSoon = await post(
      reschedule,
      "/reschedule",
      late.booking.appointmentId,
      {
        proposedSlots: hourAt(
          new Date(Math.ceil((Date.now() + 5 * 60_000) / 60_000) * 60_000),
        ),
      },
    );
    expect(tooSoon.status).toBe(400);
    expect((await tooSoon.json()).code).toBe("PROPOSAL_TOO_SOON");
    expect(
      (
        await bookingState(
          late.booking.appointmentId,
          late.booking.consultationId!,
        )
      ).requests,
    ).toEqual([]);

    const host = await seedHost();
    const buyer = await seedConsultee();
    const startsAt = hoursAhead(24 * 5);
    const unpaid = await seedOneToOne(
      "consultation",
      host,
      buyer,
      { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
      {
        status: "APPROVED_PENDING_PAYMENT",
        isTentative: true,
        payment: { status: "PENDING" },
      },
    );
    sessionUser.current = {
      id: buyer.userId,
      role: "CONSULTEE",
      consulteeProfileId: buyer.consulteeProfileId,
      consultantProfileId: null,
      name: "Buyer",
    };
    const live = await post(reschedule, "/reschedule", unpaid.appointmentId);
    expect(live.status).toBe(409);
    expect((await live.json()).code).toBe("PAY_LINK_LIVE");
    const untouched = await bookingState(
      unpaid.appointmentId,
      unpaid.consultationId!,
    );
    expect(untouched.status).toBe("APPROVED_PENDING_PAYMENT");
    expect(untouched.requests).toEqual([]);
  });

  it("one failing proposal is rotated behind the rest instead of blocking the run", async () => {
    const first = await paidConsultation();
    expect(
      (await post(reschedule, "/reschedule", first.booking.appointmentId))
        .status,
    ).toBe(200);
    const second = await paidConsultation();
    expect(
      (await post(reschedule, "/reschedule", second.booking.appointmentId))
        .status,
    ).toBe(200);
    const bad = await prisma.rescheduleRequest.findFirstOrThrow({
      where: { appointmentId: first.booking.appointmentId },
    });
    poison.add(bad.id);
    // Both lapsed; the bad one is first in line.
    await prisma.rescheduleRequest.update({
      where: { id: bad.id },
      data: {
        expiresAt: new Date(Date.now() - 60_000),
        updatedAt: new Date(Date.now() - 120_000),
      },
    });
    await prisma.rescheduleRequest.updateMany({
      where: { appointmentId: second.booking.appointmentId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const run = await expireRescheduleProposals({ maxPerRun: 25 });
    poison.clear();
    expect(run.errors).toEqual([expect.stringContaining(bad.id)]);
    const good = await bookingState(
      second.booking.appointmentId,
      second.booking.consultationId!,
    );
    expect(good.status).toBe("APPROVED");
    expect(good.requests[0]).toMatchObject({ status: "EXPIRED" });
    const rotated = await prisma.rescheduleRequest.findUniqueOrThrow({
      where: { id: bad.id },
      select: { status: true, updatedAt: true },
    });
    expect(rotated.status).toBe("PENDING_REVIEW");
    expect(rotated.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe("a release spanning two plan weeks", () => {
  it("is refused before any confirmed time moves; one week at a time works", async () => {
    const host = await seedHost();
    const buyer = await seedConsultee();
    const first = hoursAhead(24 * 3);
    const booking = await seedOneToOne(
      "subscription",
      host,
      buyer,
      { startsAt: first, endsAt: new Date(first.getTime() + HOUR_MS) },
      {
        status: "APPROVED",
        isTentative: false,
        payment: { status: "SUCCEEDED", expiresAt: null },
      },
    );
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { id: booking.subscriptionId! },
      select: { subscriptionPlanId: true },
    });
    await prisma.subscriptionPlan.update({
      where: { id: sub.subscriptionPlanId },
      data: { sessionsPerWeek: 1, durationInMonths: 1, totalSessions: 4 },
    });
    // This week's session and next week's (opened once this week was full).
    const second = new Date(first.getTime() + 7 * 24 * HOUR_MS);
    await prisma.appointmentOccurrence.create({
      data: {
        appointmentId: booking.appointmentId,
        ordinal: 2,
        startsAt: second,
        endsAt: new Date(second.getTime() + HOUR_MS),
        isTentative: false,
        consultantProfileId: host.consultantProfileId,
        completionStatus: "SCHEDULED",
      },
    });
    sessionUser.current = {
      id: buyer.userId,
      role: "CONSULTEE",
      consulteeProfileId: buyer.consulteeProfileId,
      consultantProfileId: null,
      name: "Buyer",
    };
    const live = () =>
      prisma.appointmentOccurrence.count({
        where: {
          appointmentId: booking.appointmentId,
          completionStatus: "SCHEDULED",
          isTentative: false,
        },
      });

    const both = await post(reschedule, "/reschedule", booking.appointmentId);
    expect(both.status).toBe(409);
    expect(await both.json()).toMatchObject({
      code: "RELEASE_ONE_WEEK",
      error: RELEASE_ONE_WEEK_MESSAGE,
    });
    expect(await live()).toBe(2);
    expect(
      await prisma.rescheduleRequest.count({
        where: { appointmentId: booking.appointmentId },
      }),
    ).toBe(0);

    const one = await post(reschedule, "/reschedule", booking.appointmentId, {
      slotIds: [booking.occurrenceId],
    });
    expect(one.status).toBe(200);
    expect(await live()).toBe(1);
  }, 60_000);
});
