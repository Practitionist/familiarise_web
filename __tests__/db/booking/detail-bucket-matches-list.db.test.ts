/**
 * The booking page files a booking in the same tab as the learner's list: both
 * readers' real output, mapped, gives one bucket. A lapsed hold is Cancelled on
 * both, so its page offers "Book again".
 */
import { readConsulteeEvents } from "../../../lib/data/consultee-events-read";
import {
  readAppointmentDetail,
  scopeAppointmentDetail,
} from "../../../lib/data/appointment-detail";
import { mapConsulteeEvents } from "../../../lib/appointments/map-consultee";
import { mapAppointmentDetail } from "../../../lib/appointments/map-detail";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "./harness";
import { seedHeldSeat, seedWebinar } from "./harness-seats";

const PAST = () => new Date(Date.now() - 60_000);
const FUTURE = () => new Date(Date.now() + 30 * 60_000);

async function booking(shape: {
  status: "PENDING" | "APPROVED_PENDING_PAYMENT";
  bookingSource: "DIRECT_CHECKOUT" | "REQUEST_SUBMITTED";
  expiresAt: Date;
}) {
  const consultee = await seedConsultee();
  const startsAt = futureAt(4, 11);
  const seeded = await seedOneToOne(
    "consultation",
    await seedHost(),
    consultee,
    { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
    {
      status: shape.status,
      bookingSource: shape.bookingSource,
      isTentative: true,
      payment: { status: "PENDING", expiresAt: shape.expiresAt },
    },
  );
  return { consultee, appointmentId: seeded.appointmentId };
}

async function buckets(
  consultee: { userId: string; consulteeProfileId: string },
  appointmentId: string,
) {
  const now = new Date();
  const events = await readConsulteeEvents(consultee.consulteeProfileId, {
    kind: "personal",
  });
  const row = mapConsulteeEvents(events, now).find(
    (vm) => vm.appointmentId === appointmentId,
  );
  const detail = await readAppointmentDetail(appointmentId);
  const { vm } = mapAppointmentDetail(
    scopeAppointmentDetail(detail!, {
      userId: consultee.userId,
      managesGroupPlan: false,
    }),
    "consultee",
    now,
  );
  return {
    list: [row?.bucket, row?.needsActionReason],
    detail: [vm.bucket, vm.needsActionReason],
  };
}

describe("the booking page buckets a booking as the list does", () => {
  it.each([
    [
      "a lapsed pay-first hold",
      {
        status: "PENDING",
        bookingSource: "DIRECT_CHECKOUT",
        expiresAt: PAST(),
      },
      ["cancelled", null],
    ],
    [
      "a lapsed approved request",
      {
        status: "APPROVED_PENDING_PAYMENT",
        bookingSource: "REQUEST_SUBMITTED",
        expiresAt: PAST(),
      },
      ["cancelled", null],
    ],
    [
      "a pay-first hold still inside its window",
      {
        status: "PENDING",
        bookingSource: "DIRECT_CHECKOUT",
        expiresAt: FUTURE(),
      },
      ["needsAction", "PAY_NOW"],
    ],
  ] as const)("%s", async (_name, shape, expected) => {
    const { consultee, appointmentId } = await booking(shape);
    const { list, detail } = await buckets(consultee, appointmentId);
    expect(list).toEqual(expected);
    expect(detail).toEqual(list);
  });

  it("a plan manager who sees the roster is never handed another learner's seat", async () => {
    const webinar = await seedWebinar();
    // The roster's first learner seat is someone else's lapsed hold.
    await seedHeldSeat(webinar, { status: "PENDING", expiresAt: PAST() });
    const detail = await readAppointmentDetail(webinar.appointmentId);
    const { vm } = mapAppointmentDetail(
      scopeAppointmentDetail(detail!, {
        userId: webinar.host.userId,
        managesGroupPlan: true,
      }),
      "consultee",
      new Date(),
      undefined,
      webinar.host.userId,
    );
    expect([vm.seatStatus, vm.bucket]).toEqual([null, "upcoming"]);
  });
});
