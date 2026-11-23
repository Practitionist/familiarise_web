/**
 * The payout hold of a paid 1:1 through the real reschedule doors: an open
 * proposal holds the earnings a week past the released end, a confirmed move
 * (auto-confirm, the other side's accept, or the expert placing times over an
 * open request) holds them to the new end plus the hold hours, and a
 * withdrawn, expired or declined one restores the old end's.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
  type SeededHost,
} from "./harness";
import { halfHourStarts, publishEveryHour } from "./harness-host";

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
import { POST as respond } from "../../../app/api/appointments/[appointmentId]/reschedule/respond/route";
import { POST as withdraw } from "../../../app/api/appointments/[appointmentId]/reschedule/withdraw/route";
import { expireRescheduleProposals } from "../../../scripts/appointments/expire-reschedule-proposals";
import { allocate } from "../../../lib/booking/allocation";

const DAY_MS = 24 * HOUR_MS;
const HOLD_MS = 48 * HOUR_MS;

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

/** An hour starting at `at`, as the two half-hour slots the route takes. */
const hourAt = (at: Date) =>
  [0, 1].map((half) => ({
    startsAt: new Date(at.getTime() + half * 30 * 60_000).toISOString(),
    endsAt: new Date(at.getTime() + (half + 1) * 30 * 60_000).toISOString(),
  }));

/** A paid-out earning 90 days old, so no new-expert days ride on the hold. */
async function establish(host: SeededHost) {
  const buyer = await seedConsultee();
  const past = new Date(Date.now() - 90 * DAY_MS);
  const earlier = await seedOneToOne(
    "consultation",
    host,
    buyer,
    { startsAt: past, endsAt: new Date(past.getTime() + HOUR_MS) },
    {
      status: "COMPLETED",
      isTentative: false,
      completionStatus: "COMPLETED",
      payment: { status: "SUCCEEDED", expiresAt: null },
    },
  );
  await prisma.consultantEarnings.create({
    data: {
      consultantProfileId: host.consultantProfileId,
      paymentId: earlier.payment!.id,
      grossAmount: BigInt(2_500_000),
      platformFeePaise: BigInt(500_000),
      consultantSharePaise: BigInt(2_000_000),
      status: "READY",
      holdUntil: past,
      createdAt: past,
    },
  });
}

/** A paid ₹500 consultation 03:30-04:30Z five days out, held to old end + 48 h. */
async function paidBooking() {
  const host = await seedHost();
  await publishEveryHour(host);
  await establish(host);
  const buyer = await seedConsultee();
  const oldStart = futureAt(5, 3, 30);
  const oldEnd = new Date(oldStart.getTime() + HOUR_MS);
  const booking = await seedOneToOne(
    "consultation",
    host,
    buyer,
    { startsAt: oldStart, endsAt: oldEnd },
    {
      status: "APPROVED",
      isTentative: false,
      payment: { status: "SUCCEEDED", expiresAt: null, amount: 50_000 },
    },
  );
  const paymentId = booking.payment!.id;
  const original = new Date(oldEnd.getTime() + HOLD_MS);
  const org = await prisma.organization.create({
    data: { name: "Host org", slug: `db-tier-${randomUUID()}` },
  });
  const consultantEarning = await prisma.consultantEarnings.create({
    data: {
      consultantProfileId: host.consultantProfileId,
      paymentId,
      grossAmount: BigInt(50_000),
      platformFeePaise: BigInt(10_000),
      consultantSharePaise: BigInt(40_000),
      appointmentOccurrenceId: booking.occurrenceId,
      status: "PENDING",
      holdUntil: original,
    },
  });
  const orgEarning = await prisma.organizationEarnings.create({
    data: {
      organizationId: org.id,
      paymentId,
      grossAmountPaise: BigInt(50_000),
      platformFeePaise: BigInt(10_000),
      orgSharePaise: BigInt(5_000),
      consultantSharePaise: BigInt(35_000),
      status: "PENDING",
      holdUntil: original,
    },
  });
  const asBuyer = () => {
    sessionUser.current = {
      id: buyer.userId,
      role: "CONSULTEE",
      consulteeProfileId: buyer.consulteeProfileId,
      consultantProfileId: null,
      name: "Buyer",
    };
  };
  const asExpert = () => {
    sessionUser.current = {
      id: host.userId,
      role: "CONSULTANT",
      consulteeProfileId: null,
      consultantProfileId: host.consultantProfileId,
      name: "Expert",
    };
  };
  const holds = async () => {
    const [ce, oe] = await Promise.all([
      prisma.consultantEarnings.findUniqueOrThrow({
        where: { id: consultantEarning.id },
        select: { holdUntil: true },
      }),
      prisma.organizationEarnings.findUniqueOrThrow({
        where: { id: orgEarning.id },
        select: { holdUntil: true },
      }),
    ]);
    return { consultant: ce.holdUntil, org: oe.holdUntil };
  };
  return {
    booking,
    oldEnd,
    original,
    newStart: futureAt(5, 11, 30),
    asBuyer,
    asExpert,
    holds,
  };
}

type Booking = Awaited<ReturnType<typeof paidBooking>>;

const both = (at: Date) => ({ consultant: at, org: at });

describe("the earnings hold across a reschedule's endings", () => {
  it("an auto-confirmed move holds to the new end plus 48 hours", async () => {
    const b = await paidBooking();
    b.asBuyer();
    const res = await post(reschedule, "/reschedule", b.booking.appointmentId, {
      proposedSlots: hourAt(b.newStart),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ autoConfirmed: true });
    const newEnd = new Date(b.newStart.getTime() + HOUR_MS);
    expect(await b.holds()).toEqual(both(new Date(newEnd.getTime() + HOLD_MS)));
  });

  it("an open proposal keeps the buffer; the buyer's accept holds to the new end plus 48 hours", async () => {
    const b = await paidBooking();
    b.asExpert();
    const opened = await post(
      reschedule,
      "/reschedule",
      b.booking.appointmentId,
      { proposedSlots: hourAt(b.newStart) },
    );
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ autoConfirmed: false });
    expect(await b.holds()).toEqual(
      both(new Date(b.oldEnd.getTime() + 7 * DAY_MS + HOLD_MS)),
    );

    b.asBuyer();
    const accepted = await post(
      respond,
      "/reschedule/respond",
      b.booking.appointmentId,
      { action: "accept" },
    );
    expect(accepted.status).toBe(200);
    const newEnd = new Date(b.newStart.getTime() + HOUR_MS);
    expect(await b.holds()).toEqual(both(new Date(newEnd.getTime() + HOLD_MS)));
  });

  it("an 'any time works' request keeps the buffer; the expert's placed time holds to the new end plus 48 hours", async () => {
    const b = await paidBooking();
    b.asBuyer();
    const opened = await post(
      reschedule,
      "/reschedule",
      b.booking.appointmentId,
    );
    expect(opened.status).toBe(200);
    expect(await b.holds()).toEqual(
      both(new Date(b.oldEnd.getTime() + 7 * DAY_MS + HOLD_MS)),
    );

    const placed = await allocate({
      eventType: "consultation",
      eventId: b.booking.consultationId!,
      mode: "manual",
      slots: halfHourStarts(b.newStart),
    });
    expect(placed).toMatchObject({ success: true });
    const request = await prisma.rescheduleRequest.findFirstOrThrow({
      where: { appointmentId: b.booking.appointmentId },
      select: { status: true },
    });
    expect(request.status).toBe("ACCEPTED");
    const newEnd = new Date(b.newStart.getTime() + HOUR_MS);
    expect(await b.holds()).toEqual(both(new Date(newEnd.getTime() + HOLD_MS)));
  });

  /** Each ending through its real door; answers the HTTP status it got. */
  const endings = {
    withdraw: async (b: Booking) =>
      (await post(withdraw, "/reschedule/withdraw", b.booking.appointmentId))
        .status,
    expire: async (b: Booking) => {
      await prisma.rescheduleRequest.updateMany({
        where: { openForAppointmentId: b.booking.appointmentId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      await expireRescheduleProposals({ maxPerRun: 25 });
      return 200;
    },
    decline: async (b: Booking) => {
      b.asBuyer();
      return (
        await post(respond, "/reschedule/respond", b.booking.appointmentId, {
          action: "decline",
        })
      ).status;
    },
  };

  it.each(Object.keys(endings) as (keyof typeof endings)[])(
    "a proposal that ends by %s restores the old end's hold",
    async (ending) => {
      const b = await paidBooking();
      b.asExpert();
      const opened = await post(
        reschedule,
        "/reschedule",
        b.booking.appointmentId,
        { proposedSlots: hourAt(b.newStart) },
      );
      expect(opened.status).toBe(200);
      expect((await b.holds()).consultant).not.toEqual(b.original);

      expect(await endings[ending](b)).toBe(200);
      expect(await b.holds()).toEqual(both(b.original));
    },
  );
});
