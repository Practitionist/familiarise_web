/**
 * @jest-environment node
 */

/**
 * A free event seat has no capture, so its "you're registered" notice is
 * staged after the checkout commits, from the join the commit recorded: a
 * rejoin gets its own notice, a re-stage of one join gets none, and a removal
 * landing before the staging does not swallow it.
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

// The join's claim inserts once; a second staging of the same join finds it taken.
const mockClaims = new Set<string>();
const mockClaim = jest.fn(
  async (args: { data: { scope: string; key: string; userId: string }[] }) => {
    const [row] = args.data;
    const id = `${row.scope}|${row.key}|${row.userId}`;
    if (mockClaims.has(id)) return { count: 0 };
    mockClaims.add(id);
    return { count: 1 };
  },
);
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
        idempotencyRecord: { createMany: mockClaim },
        // A host removed the learner after the join committed and before the staging ran.
        appointmentParticipant: {
          findUnique: async () => ({
            id: "part-1",
            status: "CANCELLED",
            updatedAt: new Date("2026-11-12T09:05:00Z"),
            user: { name: "Riya" },
          }),
        },
        user: { findUnique: async () => ({ name: "Riya" }) },
        appointment: { findUnique: async () => appointment },
      }),
  },
}));

import {
  freeSeatRegisteredKey,
  notifyFreeSeatRegistered,
} from "@/lib/payments/checkout/free-seat-notice";

// The join the checkout committed: its seat and the SEAT history row it wrote.
const notify = (joinId = "hist-join-1") =>
  notifyFreeSeatRegistered({
    appointmentId: "appt-1",
    userId: "u-1",
    appointmentType: "WEBINAR",
    join: { participantId: "part-1", joinId },
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockClaims.clear();
});

it("stages the booked bell and emails under the seat's own join key", async () => {
  await notify();
  expect(mockBooked).toHaveBeenCalledWith(
    ["u-1", "host-1"],
    expect.objectContaining({ appointmentId: "appt-1", consulteeName: "Riya" }),
    "seat-registered:part-1:hist-join-1",
    expect.objectContaining({ tx: expect.anything() }),
  );
  expect(mockStageEmails).toHaveBeenCalledTimes(1);
  expect(mockFlush).toHaveBeenCalledWith({
    bells: [{ id: "bell-1" }],
    emails: [{ rows: [{ id: "mail-1" }], emailType: "APPOINTMENT_BOOKED" }],
  });
});

it("gives a rejoin of the same seat a key of its own", () => {
  expect(freeSeatRegisteredKey("part-1", "hist-rejoin")).not.toBe(
    freeSeatRegisteredKey("part-1", "hist-join-1"),
  );
});

it("stages a committed join whose seat a removal released before the staging read it", async () => {
  // Nothing about the seat's current status is read: the join itself committed.
  await notify();
  expect(mockBooked).toHaveBeenCalledTimes(1);
  expect(mockStageEmails).toHaveBeenCalledTimes(1);
});

it("stages one join once across both channels, and a rejoin again", async () => {
  await notify();
  await notify();
  expect(mockBooked).toHaveBeenCalledTimes(1);
  expect(mockStageEmails).toHaveBeenCalledTimes(1);
  await notify("hist-rejoin");
  expect(mockBooked).toHaveBeenCalledTimes(2);
  expect(mockStageEmails).toHaveBeenCalledTimes(2);
});

it("never fails the committed checkout: a staging fault is reported, not thrown", async () => {
  mockStageFails.next = true;
  await expect(notify()).resolves.toBeUndefined();
  expect(mockReport).toHaveBeenCalledWith(
    expect.objectContaining({ message: "outbox unavailable" }),
    expect.objectContaining({ op: "checkout.free-seat-booked" }),
  );
});
