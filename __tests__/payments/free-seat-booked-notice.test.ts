/**
 * @jest-environment node
 */

/**
 * A free event seat has no capture, so its "you're registered" notice is staged
 * on the checkout commit's own transaction, keyed by the join that commit wrote:
 * the notice commits or rolls back with the seat, and a rejoin gets a notice of its own.
 */

const mockBooked = jest.fn(async (..._args: unknown[]) => [
  { success: true, staged: { id: "bell-1" } },
]);
jest.mock("../../lib/novu", () => ({
  notifyAppointmentBooked: (...args: unknown[]) => mockBooked(...args),
  notifyPaymentSuccess: jest.fn(),
}));
const mockStageEmails = jest.fn(async (..._args: unknown[]) => [
  { id: "mail-1" },
]);
jest.mock("../../lib/email/senders/booking", () => ({
  stageAppointmentBookedEmail: (...args: unknown[]) => mockStageEmails(...args),
  prepareAppointmentBookedEmail: jest.fn(),
}));
// Nothing here may open a transaction of its own.
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: () => {
      throw new Error("the notice opened its own transaction");
    },
  },
}));

import type { Tx } from "@/lib/prisma";
import {
  freeSeatRegisteredKey,
  stageFreeSeatNoticeTx,
} from "@/lib/payments/checkout/free-seat-notice";

const appointment = {
  id: "appt-1",
  organizationId: null,
  organization: null,
  occurrences: [
    {
      startsAt: new Date("2026-11-20T10:00:00Z"),
      endsAt: new Date("2026-11-20T11:00:00Z"),
    },
  ],
  consultation: null,
  subscription: null,
  trial: null,
  class: null,
  webinar: {
    webinarPlan: {
      title: "Intro to Python",
      collaborators: [],
      consultantProfile: { user: { id: "host-1", name: "Arjun" } },
    },
  },
};
const commitTx = {
  user: { findUnique: async () => ({ name: "Riya" }) },
  appointment: { findUnique: async () => appointment },
} as unknown as Tx;

const stage = (joinId = "hist-join-1") =>
  stageFreeSeatNoticeTx(commitTx, {
    appointmentId: "appt-1",
    userId: "u-1",
    appointmentType: "WEBINAR",
    join: { participantId: "part-1", joinId },
  });

beforeEach(() => jest.clearAllMocks());

it("stages the booked bell and emails on the commit's transaction, under the join's key", async () => {
  await expect(stage()).resolves.toEqual({
    bells: [{ id: "bell-1" }],
    emails: [{ rows: [{ id: "mail-1" }], emailType: "APPOINTMENT_BOOKED" }],
  });
  expect(mockBooked).toHaveBeenCalledWith(
    ["u-1", "host-1"],
    expect.objectContaining({ appointmentId: "appt-1", consulteeName: "Riya" }),
    "seat-registered:part-1:hist-join-1",
    expect.objectContaining({ tx: commitTx }),
  );
  expect(mockStageEmails).toHaveBeenCalledWith(
    commitTx,
    expect.anything(),
    undefined,
  );
});

it("gives a rejoin of the same seat a key of its own", () => {
  expect(freeSeatRegisteredKey("part-1", "hist-rejoin")).not.toBe(
    freeSeatRegisteredKey("part-1", "hist-join-1"),
  );
});
