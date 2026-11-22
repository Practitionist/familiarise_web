/**
 * A list row's reason line says why a booking ended as its booking page does,
 * for the learner's list and the expert's list, from each reader's real output:
 * a lapsed hold or approval "Payment was not completed in time.", a hold the
 * learner closed with Request again names that.
 */
import prisma from "../../../lib/prisma";
import { readConsulteeEvents } from "../../../lib/data/consultee-events-read";
import { getConsultantAppointments } from "../../../lib/data/consultant-appointments";
import { mapConsulteeEvents } from "../../../lib/appointments/map-consultee";
import { mapConsultantAppointments } from "../../../lib/appointments/map-consultant";
import { appointmentStatusLine } from "../../../lib/appointments/occurrences";
import { lapseApprovedRequest } from "../../../lib/booking/lapse-approved-request";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "./harness";

jest.mock("../../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: jest.fn(),
  cancelPaymentIntent: jest.fn(async () => undefined),
}));
jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/email", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/rate-limit", () =>
  jest.requireActual("./harness-edges").rateLimitMock(),
);

import { closeOrderForRequestAgain } from "../../../lib/booking/request-again";

const LAPSED = "Payment was not completed in time.";
const ago = (ms: number) => new Date(Date.now() - ms);

async function seed(shape: {
  status: "PENDING" | "APPROVED_PENDING_PAYMENT" | "EXPIRED";
  bookingSource: "DIRECT_CHECKOUT" | "REQUEST_SUBMITTED";
  payment: "PENDING" | "EXPIRED";
}) {
  const host = await seedHost();
  const consultee = await seedConsultee();
  const startsAt = futureAt(4, 13);
  const request = await seedOneToOne(
    "consultation",
    host,
    consultee,
    { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
    {
      status: shape.status,
      bookingSource: shape.bookingSource,
      isTentative: true,
      payment: { status: shape.payment, expiresAt: ago(60_000) },
    },
  );
  return { host, consultee, request };
}

async function lines(s: Awaited<ReturnType<typeof seed>>) {
  const now = new Date();
  const learnerRow = mapConsulteeEvents(
    await readConsulteeEvents(s.consultee.consulteeProfileId, {
      kind: "personal",
    }),
    now,
  ).find((vm) => vm.appointmentId === s.request.appointmentId);
  const rows = await getConsultantAppointments({
    consultantProfileId: s.host.consultantProfileId,
    scope: { kind: "personal" },
  });
  const expertRow = mapConsultantAppointments(
    { appointments: rows, consultantId: s.host.consultantProfileId },
    now,
  ).find((vm) => vm.appointmentId === s.request.appointmentId);
  return {
    learner: learnerRow && appointmentStatusLine(learnerRow, "consultee"),
    expert: expertRow && appointmentStatusLine(expertRow, "consultant"),
  };
}

describe("a list row's end reason", () => {
  it("a pay-first hold the sweep closed with no history edge: payment not completed", async () => {
    const s = await seed({
      status: "EXPIRED",
      bookingSource: "DIRECT_CHECKOUT",
      payment: "EXPIRED",
    });
    expect(await lines(s)).toEqual({ learner: LAPSED, expert: LAPSED });
  });

  it("a lapsed approval: payment not completed", async () => {
    const s = await seed({
      status: "APPROVED_PENDING_PAYMENT",
      bookingSource: "REQUEST_SUBMITTED",
      payment: "PENDING",
    });
    await prisma.$transaction((tx) =>
      lapseApprovedRequest(tx, {
        kind: "consultation",
        id: s.request.consultationId!,
        reason: "PAYMENT_LAPSED",
        actorUserId: null,
      }),
    );
    expect(await lines(s)).toEqual({ learner: LAPSED, expert: LAPSED });
  });

  it("a pay-first hold closed by Request again names the new request", async () => {
    const s = await seed({
      status: "PENDING",
      bookingSource: "DIRECT_CHECKOUT",
      payment: "PENDING",
    });
    await expect(
      closeOrderForRequestAgain({
        appointmentId: s.request.appointmentId,
        userId: s.consultee.userId,
      }),
    ).resolves.toEqual({ ok: true, closed: 1 });
    expect(await lines(s)).toEqual({
      learner: "You closed this payment link and requested again.",
      expert: "The learner closed this payment link and requested again.",
    });
  });
});
