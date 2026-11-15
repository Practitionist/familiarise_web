/**
 * Decline is for requests. A paid, confirmed booking that a reschedule put
 * back to PENDING answers 409 on every decline door (detail and list, 1:1 and
 * plan) and nothing moves: no cancel, no refund marker, the proposal stays open.
 */
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import { HOUR_MS, seedConsultee, seedHost, seedOneToOne } from "./harness";
import { publishEveryHour } from "./harness-host";

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

import { POST as reschedule } from "../../../app/api/appointments/[appointmentId]/reschedule/route";
import { PATCH as patchConsultation } from "../../../app/api/bookings/consultations/[consultationId]/route";
import { PATCH as patchConsultationList } from "../../../app/api/bookings/consultations/route";
import { PATCH as patchSubscription } from "../../../app/api/bookings/subscriptions/[subscriptionId]/route";
import { PATCH as patchSubscriptionList } from "../../../app/api/bookings/subscriptions/route";
import {
  countOpenRequestsForCap,
  countRequestsToAnswer,
} from "../../../lib/data/needs-you";
import { countActiveConsultationRequests } from "../../../lib/booking/request-caps";

const hoursAhead = (hours: number) =>
  new Date(Math.ceil((Date.now() + hours * HOUR_MS) / HOUR_MS) * HOUR_MS);

const json = (url: string, method: string, body?: unknown) =>
  new NextRequest(url, {
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        }),
  });

async function movingBooking(kind: "consultation" | "subscription") {
  const host = await seedHost();
  const buyer = await seedConsultee();
  const startsAt = hoursAhead(24 * 5);
  const booking = await seedOneToOne(
    kind,
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
  // "Any time works": a whole-booking release that re-enters PENDING.
  const released = await reschedule(
    json(
      `http://localhost/api/appointments/${booking.appointmentId}/reschedule`,
      "POST",
    ),
    { params: Promise.resolve({ appointmentId: booking.appointmentId }) },
  );
  expect(released.status).toBe(200);
  sessionUser.current = {
    id: host.userId,
    role: "CONSULTANT",
    consultantProfileId: host.consultantProfileId,
    consulteeProfileId: null,
    name: "Host",
  };
  return booking;
}

async function decline(
  kind: "consultation" | "subscription",
  door: "detail" | "list",
  id: string,
) {
  const base = `http://localhost/api/bookings/${kind}s`;
  if (door === "list") {
    const req = json(base, "PATCH", { id, status: "REJECTED" });
    return kind === "consultation"
      ? patchConsultationList(req)
      : patchSubscriptionList(req);
  }
  const req = json(`${base}/${id}`, "PATCH", { status: "REJECTED" });
  return kind === "consultation"
    ? patchConsultation(req, {
        params: Promise.resolve({ consultationId: id }),
      })
    : patchSubscription(req, {
        params: Promise.resolve({ subscriptionId: id }),
      });
}

describe.each([
  ["consultation", "detail"],
  ["consultation", "list"],
  ["subscription", "detail"],
  ["subscription", "list"],
] as const)("declining a %s being moved (%s door)", (kind, door) => {
  it("answers 409 USE_RESCHEDULE_RESPOND and leaves the booking intact", async () => {
    const booking = await movingBooking(kind);
    const id = (booking.consultationId ?? booking.subscriptionId)!;

    const res = await decline(kind, door, id);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("USE_RESCHEDULE_RESPOND");

    const status =
      kind === "consultation"
        ? (
            await prisma.consultation.findUniqueOrThrow({
              where: { id },
              select: { status: true },
            })
          ).status
        : (
            await prisma.subscription.findUniqueOrThrow({
              where: { id },
              select: { status: true },
            })
          ).status;
    expect(status).toBe("PENDING");
    const occurrences = await prisma.appointmentOccurrence.findMany({
      where: { appointmentId: booking.appointmentId },
      select: { completionStatus: true, deletedAt: true },
    });
    expect(occurrences).toEqual([
      { completionStatus: "RESCHEDULED", deletedAt: null },
    ]);
    const open = await prisma.rescheduleRequest.count({
      where: {
        appointmentId: booking.appointmentId,
        status: "PENDING_REVIEW",
      },
    });
    expect(open).toBe(1);
    const refunds = await prisma.refund.count({
      where: { payment: { appointmentId: booking.appointmentId } },
    });
    expect(refunds).toBe(0);
  });
});

describe.each(["consultation", "subscription"] as const)(
  "approving a %s being moved through the status PATCH",
  (kind) => {
    it("answers 409 USE_RESCHEDULE_RESPOND and leaves the booking intact", async () => {
      const booking = await movingBooking(kind);
      const id = (booking.consultationId ?? booking.subscriptionId)!;
      const base = `http://localhost/api/bookings/${kind}s/${id}`;
      const req = json(base, "PATCH", { status: "APPROVED" });
      const res =
        kind === "consultation"
          ? await patchConsultation(req, {
              params: Promise.resolve({ consultationId: id }),
            })
          : await patchSubscription(req, {
              params: Promise.resolve({ subscriptionId: id }),
            });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("USE_RESCHEDULE_RESPOND");
      const occurrences = await prisma.appointmentOccurrence.findMany({
        where: { appointmentId: booking.appointmentId },
        select: { completionStatus: true, isTentative: true },
      });
      expect(occurrences).toEqual([
        { completionStatus: "RESCHEDULED", isTentative: true },
      ]);
    });
  },
);

describe("a stranded booking (released, no open proposal)", () => {
  // The proposal lapsed without a restore: the session stays released.
  async function strandedBooking() {
    const booking = await movingBooking("consultation");
    await prisma.rescheduleRequest.updateMany({
      where: { appointmentId: booking.appointmentId },
      data: {
        status: "EXPIRED",
        openForAppointmentId: null,
        resolvedAt: new Date(),
      },
    });
    return booking;
  }

  it("answers 409 USE_CANCEL_ENDPOINT instead of declining", async () => {
    const booking = await strandedBooking();
    const res = await decline(
      "consultation",
      "detail",
      booking.consultationId!,
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("USE_CANCEL_ENDPOINT");
  });

  it("refuses an approval with PLACE_RELEASED_SESSIONS", async () => {
    const booking = await strandedBooking();
    const id = booking.consultationId!;
    const res = await patchConsultation(
      json(`http://localhost/api/bookings/consultations/${id}`, "PATCH", {
        status: "APPROVED",
      }),
      { params: Promise.resolve({ consultationId: id }) },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PLACE_RELEASED_SESSIONS");
  });
});

describe("a booking being moved is not a new request", () => {
  async function released(by: "CONSULTEE" | "CONSULTANT") {
    const host = await seedHost();
    // An expert's proposed times are checked against their published hours.
    await publishEveryHour(host);
    const buyer = await seedConsultee();
    const startsAt = hoursAhead(24 * 5);
    const booking = await seedOneToOne(
      "consultation",
      host,
      buyer,
      { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
      {
        status: "APPROVED",
        bookingSource: "REQUEST_SUBMITTED",
        isTentative: false,
        payment: { status: "SUCCEEDED", expiresAt: null },
      },
    );
    sessionUser.current =
      by === "CONSULTEE"
        ? {
            id: buyer.userId,
            role: "CONSULTEE",
            consulteeProfileId: buyer.consulteeProfileId,
            consultantProfileId: null,
            name: "Buyer",
          }
        : {
            id: host.userId,
            role: "CONSULTANT",
            consultantProfileId: host.consultantProfileId,
            consulteeProfileId: null,
            name: "Host",
          };
    // The consultant names times (a proposal the client must accept); the
    // client lets the consultant choose ("any time works").
    const at = hoursAhead(24 * 6);
    const res = await reschedule(
      json(
        `http://localhost/api/appointments/${booking.appointmentId}/reschedule`,
        "POST",
        by === "CONSULTANT"
          ? {
              proposedSlots: [0, 1].map((half) => ({
                startsAt: new Date(
                  at.getTime() + half * 30 * 60_000,
                ).toISOString(),
                endsAt: new Date(
                  at.getTime() + (half + 1) * 30 * 60_000,
                ).toISOString(),
              })),
            }
          : undefined,
      ),
      { params: Promise.resolve({ appointmentId: booking.appointmentId }) },
    );
    expect(res.status).toBe(200);
    return { host, buyer };
  }

  it("the consultant's own proposal never counts as a request to answer", async () => {
    const { host } = await released("CONSULTANT");
    expect(
      await countRequestsToAnswer({
        consultantProfileId: host.consultantProfileId,
      }),
    ).toBe(0);
  });

  it("the client's proposal is still the consultant's to answer", async () => {
    const { host } = await released("CONSULTEE");
    expect(
      await countRequestsToAnswer({
        consultantProfileId: host.consultantProfileId,
      }),
    ).toBe(1);
  });

  it("neither request cap counts it", async () => {
    const { host, buyer } = await released("CONSULTEE");
    expect(await countOpenRequestsForCap(host.consultantProfileId)).toBe(0);
    expect(
      await countActiveConsultationRequests(prisma, buyer.consulteeProfileId),
    ).toBe(0);
  });
});
