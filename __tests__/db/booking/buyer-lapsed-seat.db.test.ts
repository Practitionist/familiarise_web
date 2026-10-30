/**
 * A dual-role buyer (an expert who also books as a client) is walled out of a
 * time only by seats that still hold it: a lapsed seat hold (its payment
 * PENDING past its deadline) never blocks their own next booking.
 */
jest.mock("../../../lib/novu", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop === "then" ? undefined : prop === "__esModule" ? true : noop,
    },
  );
});
import prisma from "../../../lib/prisma";
import { seedConsultee, seedDualRole, seedHost, seedOneToOne } from "./harness";
import { seedWebinar } from "./harness-seats";
import { consulteeHasOverlappingSession } from "../../../lib/payments/checkout/occupancy-validate";
import { randomUUID } from "node:crypto";
import { ScheduleValidationService } from "../../../utils/scheduling-engine/ScheduleValidationService";
import { confirmExistingAppointment } from "../../../lib/payments/webhooks/handlers";
import { findAvailableSlots } from "../../../lib/booking/allocation/search/find-available-slots";
import { SlotShortageError } from "../../../utils/scheduling-engine/errors";

async function dualRoleSeatOn(expiresAt: Date) {
  const webinar = await seedWebinar({ capacity: 5 });
  const buyer = await seedDualRole();
  const price = BigInt(50_000);
  const payment = await prisma.payment.create({
    data: {
      amount: price,
      originalAmount: price,
      paymentMethod: "card",
      paymentIntent: `order_dbtier_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
      paymentStatus: "PENDING",
      userId: buyer.userId,
      appointmentId: webinar.appointmentId,
      isMockPayment: true,
      expiresAt,
      legs: { create: [{ source: "CARD", amountPaise: price }] },
    },
  });
  await prisma.appointmentParticipant.create({
    data: {
      appointmentId: webinar.appointmentId,
      userId: buyer.userId,
      role: "CONSULTEE",
      status: "HELD",
      paymentId: payment.id,
    },
  });
  return { webinar, buyer };
}

const overlaps = (userId: string, window: { startsAt: Date; endsAt: Date }) =>
  prisma.$transaction((tx) =>
    consulteeHasOverlappingSession(tx, {
      userId,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      selfHoldAppointmentIds: [],
    }),
  );

it("a lapsed seat hold does not wall a dual-role buyer out of the same time", async () => {
  const { webinar, buyer } = await dualRoleSeatOn(
    new Date(Date.now() - 60_000),
  );
  expect(await overlaps(buyer.userId, webinar)).toBe(false);
});

it("a live seat hold still does", async () => {
  const { webinar, buyer } = await dualRoleSeatOn(
    new Date(Date.now() + 10 * 60_000),
  );
  expect(await overlaps(buyer.userId, webinar)).toBe(true);
});

// ---------------------------------------------------------------------------
// The production validator and the capture recheck use the same seat
// liveness: a HELD seat whose own payment lapsed (EXPIRED, FAILED, PENDING
// past due) holds no time; a live hold and a CONFIRMED seat (even with an old
// payment deadline) do.
// ---------------------------------------------------------------------------

type SeatShape = {
  status: "HELD" | "CONFIRMED";
  paymentStatus: "PENDING" | "EXPIRED" | "FAILED" | "SUCCEEDED";
  expiresAt: Date;
};

const PAST = () => new Date(Date.now() - 60 * 60_000);
const FUTURE = () => new Date(Date.now() + 10 * 60_000);

const SEATS: Array<[string, () => SeatShape, boolean]> = [
  [
    "an EXPIRED-payment hold",
    () => ({ status: "HELD", paymentStatus: "EXPIRED", expiresAt: PAST() }),
    false,
  ],
  [
    "a FAILED-payment hold",
    () => ({ status: "HELD", paymentStatus: "FAILED", expiresAt: FUTURE() }),
    false,
  ],
  [
    "a past-due PENDING hold",
    () => ({ status: "HELD", paymentStatus: "PENDING", expiresAt: PAST() }),
    false,
  ],
  [
    "a live PENDING hold",
    () => ({ status: "HELD", paymentStatus: "PENDING", expiresAt: FUTURE() }),
    true,
  ],
  [
    "a CONFIRMED seat with an old deadline",
    () => ({
      status: "CONFIRMED",
      paymentStatus: "SUCCEEDED",
      expiresAt: PAST(),
    }),
    true,
  ],
];

/** A consultee holding a seat of `shape` on a webinar at the webinar's time. */
async function consulteeWithSeat(shape: SeatShape) {
  const webinar = await seedWebinar({ capacity: 5 });
  const consultee = await seedConsultee();
  const price = BigInt(50_000);
  const payment = await prisma.payment.create({
    data: {
      amount: price,
      originalAmount: price,
      paymentMethod: "card",
      paymentIntent: `order_dbtier_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
      paymentStatus: shape.paymentStatus,
      userId: consultee.userId,
      appointmentId: webinar.appointmentId,
      isMockPayment: true,
      expiresAt: shape.expiresAt,
      legs: { create: [{ source: "CARD", amountPaise: price }] },
    },
  });
  await prisma.appointmentParticipant.create({
    data: {
      appointmentId: webinar.appointmentId,
      userId: consultee.userId,
      role: "CONSULTEE",
      status: shape.status,
      paymentId: payment.id,
    },
  });
  return { webinar, consultee };
}

describe("seat liveness in the production validator", () => {
  it.each(SEATS)(
    "%s: held against the consultee's time only while it is live",
    async (_label, shape, blocks) => {
      const { webinar, consultee } = await consulteeWithSeat(shape());
      const expert = await seedHost();
      const slots = [
        webinar.startsAt,
        new Date(webinar.startsAt.getTime() + 30 * 60_000),
      ];
      const result = await new ScheduleValidationService(
        prisma,
      ).checkSlotAvailability(
        slots,
        expert.userId,
        expert.consultantProfileId,
        consultee.userId,
      );
      expect(result.isValid).toBe(!blocks);
    },
  );
});

describe("seat liveness in the capture recheck", () => {
  it.each(SEATS)(
    "%s: blocks the consultee's 1:1 capture only while it is live",
    async (_label, shape, blocks) => {
      const { webinar, consultee } = await consulteeWithSeat(shape());
      const expert = await seedHost();
      const booking = await seedOneToOne(
        "consultation",
        expert,
        consultee,
        { startsAt: webinar.startsAt, endsAt: webinar.endsAt },
        {
          status: "APPROVED_PENDING_PAYMENT",
          bookingSource: "REQUEST_SUBMITTED",
          isTentative: true,
        },
      );
      const outcome = await prisma.$transaction((tx) =>
        confirmExistingAppointment(tx, booking.appointmentId, consultee.userId),
      );
      expect(outcome.doubleBookingBlocked === true).toBe(blocks);
    },
  );
});

// ---------------------------------------------------------------------------
// The allocator's search reads the same seat liveness as the validator, on
// both arms: the consultee's own seats and the expert's seats as a client.
// ---------------------------------------------------------------------------

/** One hour of custom availability exactly over the webinar's time. */
const availableOnlyAt = (
  userId: string,
  window: { startsAt: Date; endsAt: Date },
) => ({
  userId,
  scheduleType: "CUSTOM" as const,
  availabilityWindowsWeekly: [],
  availabilityWindowsCustom: [{ id: randomUUID(), ...window }],
  hasCustomRows: true,
});

const search = (
  expert: { userId: string; consultantProfileId: string },
  window: { startsAt: Date; endsAt: Date },
  consulteeUserId: string,
) =>
  findAvailableSlots(
    prisma,
    availableOnlyAt(expert.userId, window),
    1,
    1,
    "consultation",
    { durationInHours: 1 },
    [],
    [],
    consulteeUserId,
    expert.consultantProfileId,
  ).then(
    (starts) => starts.map((s) => s.getTime()),
    (error: unknown) =>
      error instanceof SlotShortageError ? ("shortage" as const) : error,
  );

describe("seat liveness in the allocator search", () => {
  it.each(SEATS)(
    "%s: keeps the consultee's time off the search only while it is live",
    async (_label, shape, blocks) => {
      const { webinar, consultee } = await consulteeWithSeat(shape());
      const expert = await seedHost();
      const found = await search(expert, webinar, consultee.userId);
      expect(found).toEqual(blocks ? "shortage" : [webinar.startsAt.getTime()]);
    },
  );

  it.each([
    ["a lapsed", new Date(Date.now() - 60_000), false],
    ["a live", new Date(Date.now() + 10 * 60_000), true],
  ] as const)(
    "%s seat the expert holds as a client elsewhere is busy only while it is live",
    async (_label, expiresAt, blocks) => {
      const { webinar, buyer: expert } = await dualRoleSeatOn(expiresAt);
      const consultee = await seedConsultee();
      const found = await search(expert, webinar, consultee.userId);
      expect(found).toEqual(blocks ? "shortage" : [webinar.startsAt.getTime()]);
    },
  );
});
