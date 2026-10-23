/** @jest-environment node */
const findSlots = jest.fn();
const transaction = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointmentOccurrence: {
      findMany: (...args: unknown[]) => findSlots(...args),
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
import { freezeAppointments } from "../../actions/maintenance/freeze-appointments";
import { assertMaintenanceRemediationCapacity } from "../../lib/maintenance-remediation-capacity";
beforeEach(() => jest.clearAllMocks());
it("refuses oversized worker input before a cancellation transaction or delivery is started", async () => {
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
  expect(transaction).not.toHaveBeenCalled();
  expect(findSlots).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ appointmentId: "large" }),
      take: 13,
    }),
  );
});
it("rejects current database counts instead of loading and truncating a large roster", async () => {
  const findMany = jest
    .fn()
    .mockResolvedValue([
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
