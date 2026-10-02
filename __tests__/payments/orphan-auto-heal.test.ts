/**
 * @jest-environment node
 */

jest.mock("@sentry/nextjs", () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: jest.fn((_job: string, _opts: unknown, fn: () => unknown) => fn()),
  CronLockHeldError: class CronLockHeldError extends Error {},
  CronLockUnavailableError: class CronLockUnavailableError extends Error {},
  LONG_JOB_TTL_MS: 35 * 60 * 1000,
}));
jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: jest.fn((fn: () => unknown) => fn()),
}));
jest.mock("../../lib/appointments/occurrences", () => ({
  liveOccurrenceWhere: {},
}));
jest.mock("../../lib/novu/outbox", () => ({
  attemptTrigger: jest.fn(async () => ({ success: true, outcome: "SENT" })),
}));

const mockPaymentFindMany = jest.fn();
const mockPaymentUpdateMany = jest.fn();
const mockAppointmentFindMany = jest.fn();
const mockWalletTopUpFindUnique = jest.fn();
const mockSystemEventFindFirst = jest.fn();
const mockConfirmExistingAppointment = jest.fn();
const mockRefundBookingPayment = jest.fn();
const mockRecordSystemEvent = jest.fn();
const mockReportSentryMessage = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findMany: (...a: unknown[]) => mockPaymentFindMany(...a),
      updateMany: (...a: unknown[]) => mockPaymentUpdateMany(...a),
    },
    appointment: {
      findMany: (...a: unknown[]) => mockAppointmentFindMany(...a),
    },
    walletTopUp: {
      findUnique: (...a: unknown[]) => mockWalletTopUpFindUnique(...a),
    },
    systemEvent: {
      findFirst: (...a: unknown[]) => mockSystemEventFindFirst(...a),
    },
    $transaction: jest.fn((fn: (tx: unknown) => unknown) =>
      fn({}),
    ),
  },
}));
jest.mock("../../lib/payments/webhooks/handlers", () => ({
  confirmExistingAppointment: (...a: unknown[]) =>
    mockConfirmExistingAppointment(...a),
}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  isInternalFundedIntent: (intent: string) => intent.startsWith("org_"),
  isFreeCreditIntent: (intent: string) => intent.startsWith("free_"),
  refundBookingPayment: (...a: unknown[]) => mockRefundBookingPayment(...a),
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemEvent: (...a: unknown[]) => mockRecordSystemEvent(...a),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryMessage: (...a: unknown[]) => mockReportSentryMessage(...a),
  reportSentryError: jest.fn(),
}));

import { reconcileOrphanedPayments } from "../../scripts/payments/reconcile-orphaned-confirmations";

const orphan = (o: Record<string, unknown> = {}) => ({
  id: "pay_orphan_1",
  paymentIntent: "order_gateway_1",
  userId: "user_1",
  createdAt: new Date(Date.now() - 2 * 3_600_000),
  ...o,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPaymentFindMany.mockResolvedValue([]);
  mockPaymentUpdateMany.mockResolvedValue({ count: 1 });
  mockAppointmentFindMany.mockResolvedValue([]);
  mockWalletTopUpFindUnique.mockResolvedValue(null);
  mockSystemEventFindFirst.mockResolvedValue(null);
  mockConfirmExistingAppointment.mockResolvedValue({
    capturedAfterTerminal: false,
  });
  mockRefundBookingPayment.mockResolvedValue({
    refundId: "rf_1",
    amountRefundedPaise: 10000,
    rail: "GATEWAY",
  });
  mockRecordSystemEvent.mockResolvedValue(undefined);
});

describe("orphan auto-heal", () => {
  it("collapses a double-fire to a single link win", async () => {
    mockPaymentFindMany.mockImplementation((args: {
      where?: { createdAt?: { lt?: Date } };
    }) => {
      // Main cohort only; escrow cohort is empty.
      if (args.where?.createdAt && "lt" in (args.where.createdAt ?? {})) {
        const lt = (args.where.createdAt as { lt?: Date }).lt;
        if (lt && Date.now() - lt.getTime() > 24 * 3_600_000) return [];
      }
      return [orphan()];
    });
    mockAppointmentFindMany.mockResolvedValue([{ id: "appt_1" }]);
    let claims = 0;
    mockPaymentUpdateMany.mockImplementation(async () => {
      claims += 1;
      return { count: claims === 1 ? 1 : 0 };
    });

    const [first, second] = await Promise.all([
      reconcileOrphanedPayments({ graceMinutes: 60, limit: 10 }),
      reconcileOrphanedPayments({ graceMinutes: 60, limit: 10 }),
    ]);

    expect([first.linked, second.linked].sort()).toEqual([0, 1]);
    expect(mockConfirmExistingAppointment).toHaveBeenCalledTimes(1);
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });

  it("refunds an unlinkable orphan once under a deterministic key", async () => {
    mockPaymentFindMany.mockImplementation((args: {
      where?: { createdAt?: unknown };
    }) =>
      args.where?.createdAt &&
      typeof args.where.createdAt === "object" &&
      "lt" in (args.where.createdAt as object) &&
      !("gte" in (args.where.createdAt as object))
        ? []
        : [orphan()],
    );
    mockAppointmentFindMany.mockResolvedValue([]);

    const r = await reconcileOrphanedPayments({ limit: 10 });

    expect(r.refunded).toBe(1);
    expect(mockRefundBookingPayment).toHaveBeenCalledTimes(1);
    expect(mockRefundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay_orphan_1",
        dedupeKey: "orphan-auto:pay_orphan_1",
      }),
    );
    const claimWhere = mockPaymentUpdateMany.mock.calls[0][0].where;
    expect(claimWhere).toMatchObject({
      id: "pay_orphan_1",
      appointmentId: null,
    });
  });

  it("excludes by-design side-charges from the cohort query", async () => {
    mockPaymentFindMany.mockResolvedValue([]);

    await reconcileOrphanedPayments({ limit: 10 });

    expect(mockPaymentFindMany).toHaveBeenCalled();
    const where = mockPaymentFindMany.mock.calls[0][0].where;
    expect(where.parentPaymentId).toBeNull();
    expect(where.NOT).toEqual({
      paymentIntent: { startsWith: "overage:" },
    });
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
    expect(mockConfirmExistingAppointment).not.toHaveBeenCalled();
  });

  it.each([["free_abc123"], ["org_wallet_abc123"]])(
    "never calls the gateway for %s intents",
    async (intent) => {
      mockPaymentFindMany.mockImplementation((args: {
        where?: { createdAt?: unknown };
      }) =>
        args.where?.createdAt &&
        typeof args.where.createdAt === "object" &&
        "lt" in (args.where.createdAt as object) &&
        !("gte" in (args.where.createdAt as object))
          ? []
          : [orphan({ paymentIntent: intent })],
      );
      mockAppointmentFindMany.mockResolvedValue([]);

      const r = await reconcileOrphanedPayments({ limit: 10 });

      expect(r.nonGatewaySkipped).toBe(1);
      expect(r.refunded).toBe(0);
      expect(mockRefundBookingPayment).not.toHaveBeenCalled();
    },
  );

  it("skips rows owned by the top-up reconciler", async () => {
    mockPaymentFindMany.mockImplementation((args: {
      where?: { createdAt?: unknown };
    }) =>
      args.where?.createdAt &&
      typeof args.where.createdAt === "object" &&
      "lt" in (args.where.createdAt as object) &&
      !("gte" in (args.where.createdAt as object))
        ? []
        : [orphan()],
    );
    mockWalletTopUpFindUnique.mockResolvedValue({ id: "topup_1" });
    mockAppointmentFindMany.mockResolvedValue([{ id: "appt_1" }]);

    const r = await reconcileOrphanedPayments({ limit: 10 });

    expect(r.topupSkipped).toBe(1);
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
    expect(mockConfirmExistingAppointment).not.toHaveBeenCalled();
  });

  it("escrows past-window rows once and never drops them", async () => {
    const stale = orphan({
      id: "pay_stale_1",
      createdAt: new Date(Date.now() - 10 * 24 * 3_600_000),
    });
    mockPaymentFindMany.mockImplementation((args: {
      where?: { createdAt?: { gte?: Date; lt?: Date } };
    }) => {
      const range = args.where?.createdAt;
      if (range && "gte" in range) return [];
      return [stale];
    });

    const first = await reconcileOrphanedPayments({ limit: 10 });
    expect(first.escrowed).toBe(1);
    expect(mockRecordSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "orphan-escrow:pay_stale_1" }),
    );
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();

    mockSystemEventFindFirst.mockResolvedValue({ id: "ev_1" });
    const second = await reconcileOrphanedPayments({ limit: 10 });
    expect(second.escrowed).toBe(0);
  });
});
