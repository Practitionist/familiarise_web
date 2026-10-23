/** @jest-environment node */
const findSlots = jest.fn();
const transaction = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointmentOccurrence: {
      findMany: () => {
        throw new Error("Booking graph must use the transaction client");
      },
    },
    $transaction: (...args: unknown[]) => transaction(...args),
  },
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/novu/service", () => ({
  notifyAppointmentCancelled: jest.fn(),
}));
jest.mock("../../lib/email/senders/booking", () => ({
  stageAppointmentCancelledEmail: jest.fn(),
}));
jest.mock("../../lib/novu/workflows", () => ({ notificationScope: jest.fn() }));
jest.mock("../../lib/novu/resolve-href", () => ({
  notificationHref: jest.fn(),
}));
jest.mock("../../lib/payments/operations/refund-owed", () => ({
  stampRefundsOwed: jest.fn(),
}));
jest.mock("../../lib/booking/transitions", () => ({
  SLOT_RESCHEDULABLE_FROM: ["SCHEDULED"],
  transitionConsultationRequest: jest.fn(),
  transitionOccurrenceCompletion: jest.fn(),
}));
jest.mock("../../lib/booking/reschedule-decline", () => ({
  declineOpenReschedules: jest.fn(),
}));
jest.mock("../../lib/enterprise/transitions", () => ({
  IllegalTransitionError: class extends Error {},
}));
jest.mock("../../lib/trials/cancellation", () => ({
  softCancelTrialAppointmentInTx: jest.fn(),
}));
import { stampRefundsOwed } from "../../lib/payments/operations/refund-owed";
import { notifyAppointmentCancelled } from "../../lib/novu/service";
import { freezeAppointments } from "../../actions/maintenance/freeze-appointments";
import { assertMaintenanceRemediationCapacity } from "../../lib/maintenance-remediation-capacity";
beforeEach(() => {
  jest.clearAllMocks();
  transaction.mockImplementation((run: (tx: unknown) => Promise<unknown>) =>
    run({
      appointmentOccurrence: {
        findMany: (...args: unknown[]) => findSlots(...args),
      },
    }),
  );
});
it("reads and rejects oversized worker input inside its serializable transaction before cancellation", async () => {
  findSlots.mockResolvedValue([
    {
      appointment: {
        id: "large",
        participants: Array.from({ length: 9 }, (_, i) => ({
          userId: String(i),
        })),
        payment: [],
      },
    },
  ]);
  await expect(
    freezeAppointments(new Date(), new Date(), "large"),
  ).rejects.toThrow("exceeds automatic maintenance remediation capacity");
  expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: "Serializable",
  });
  expect(findSlots).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ appointmentId: "large" }),
      take: 13,
    }),
  );
});
it("rejects current database counts instead of loading and truncating a large roster", async () => {
  const findMany = jest.fn().mockResolvedValue([
    {
      id: "large",
      _count: { participants: 9000, occurrences: 1, payment: 1 },
    },
  ]);
  await expect(
    assertMaintenanceRemediationCapacity({ appointment: { findMany } }, [
      "large",
    ]),
  ).rejects.toThrow("exceeds automatic maintenance remediation capacity");
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      select: expect.objectContaining({ _count: expect.anything() }),
    }),
  );
});

it("stages a payment present in the cancellation snapshot through the same transaction", async () => {
  findSlots.mockResolvedValue([
    {
      id: "slot",
      startsAt: new Date("2026-10-23T01:00Z"),
      appointment: {
        id: "booking",
        organizationId: null,
        participants: [],
        payment: [
          {
            id: "paid-after-preview",
            paymentStatus: "SUCCEEDED",
            deletedAt: null,
          },
        ],
        consultation: {
          id: "consultation",
          consultationPlan: {
            title: "Consultation",
            consultantProfile: { user: { id: "host", name: "Host" } },
          },
          requestedBy: { user: { id: "client", name: "Client" } },
        },
      },
    },
  ]);
  const result = await freezeAppointments(
    new Date("2026-10-23T01:00Z"),
    new Date("2026-10-23T02:00Z"),
    "booking",
  );
  expect(result).toMatchObject({ cancelled: 1, refundsQueued: 1 });
  expect(stampRefundsOwed).toHaveBeenCalledWith(
    expect.objectContaining({ appointmentOccurrence: expect.anything() }),
    [
      expect.objectContaining({
        paymentId: "paid-after-preview",
        key: "freeze:booking:paid-after-preview",
      }),
    ],
  );
  expect(notifyAppointmentCancelled).toHaveBeenCalledWith(
    ["client", "host"],
    expect.anything(),
    expect.objectContaining({
      tx: expect.objectContaining({ appointmentOccurrence: expect.anything() }),
      deferAttempt: true,
    }),
  );
});
