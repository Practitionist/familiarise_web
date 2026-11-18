/**
 * @jest-environment node
 */

/**
 * A free event seat has no capture, so its "you're registered" notice is
 * staged after the checkout commits, keyed per seat and join instant: a rejoin
 * gets its own notice instead of being taken for the first registration.
 */

const mockBooked = jest.fn(async (..._args: unknown[]) => [
  { success: true, staged: { id: "bell-1" } },
]);
jest.mock("../../lib/novu", () => ({
  notifyAppointmentBooked: (...args: unknown[]) => mockBooked(...args),
  notifyPaymentSuccess: jest.fn(),
}));
const mockStageEmails = jest.fn(async () => [{ id: "mail-1" }]);
jest.mock("../../lib/email/senders/booking", () => ({
  stageAppointmentBookedEmail: () => mockStageEmails(),
  prepareAppointmentBookedEmail: jest.fn(),
}));
const mockFlush = jest.fn();
const mockStageFails = { next: false };
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  stageNowAttemptAfter: async (
    _label: string,
    stage: () => Promise<unknown>,
  ) => {
    if (mockStageFails.next) {
      mockStageFails.next = false;
      throw new Error("outbox unavailable");
    }
    mockFlush(await stage());
  },
}));
const mockReport = jest.fn();
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => mockReport(...args),
}));

const mockSeat = {
  value: {
    id: "part-1",
    status: "CONFIRMED",
    updatedAt: new Date("2026-11-12T09:00:00Z"),
    user: { name: "Riya" },
  } as Record<string, unknown> | null,
};
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
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        appointmentParticipant: { findUnique: async () => mockSeat.value },
        appointment: { findUnique: async () => appointment },
      }),
  },
}));

import {
  freeSeatRegisteredKey,
  notifyFreeSeatRegistered,
} from "@/lib/payments/checkout/free-seat-notice";

const notify = () =>
  notifyFreeSeatRegistered({
    appointmentId: "appt-1",
    userId: "u-1",
    appointmentType: "WEBINAR",
  });

beforeEach(() => jest.clearAllMocks());

it("stages the booked bell and emails under the seat's own join key", async () => {
  await notify();
  expect(mockBooked).toHaveBeenCalledWith(
    ["u-1", "host-1"],
    expect.objectContaining({ appointmentId: "appt-1", consulteeName: "Riya" }),
    "seat-registered:part-1:" + Date.parse("2026-11-12T09:00:00Z"),
    expect.objectContaining({ tx: expect.anything() }),
  );
  expect(mockStageEmails).toHaveBeenCalledTimes(1);
  expect(mockFlush).toHaveBeenCalledWith({
    bells: [{ id: "bell-1" }],
    emails: [{ rows: [{ id: "mail-1" }], emailType: "APPOINTMENT_BOOKED" }],
  });
});

it("gives a rejoin of the same seat a key of its own", () => {
  const first = freeSeatRegisteredKey(
    "part-1",
    new Date("2026-11-12T09:00:00Z"),
  );
  const rejoin = freeSeatRegisteredKey(
    "part-1",
    new Date("2026-11-13T09:00:00Z"),
  );
  expect(rejoin).not.toBe(first);
});

it("sends nothing when the seat is not confirmed", async () => {
  mockSeat.value = { ...mockSeat.value, status: "CANCELLED" };
  await notify();
  expect(mockBooked).not.toHaveBeenCalled();
  expect(mockStageEmails).not.toHaveBeenCalled();
});

it("never fails the committed checkout: a staging fault is reported, not thrown", async () => {
  mockStageFails.next = true;
  await expect(notify()).resolves.toBeUndefined();
  expect(mockReport).toHaveBeenCalledWith(
    expect.objectContaining({ message: "outbox unavailable" }),
    expect.objectContaining({ op: "checkout.free-seat-booked" }),
  );
});
