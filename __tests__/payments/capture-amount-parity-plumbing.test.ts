/**
 * @jest-environment node
 */

/**
 * The captured-amount PARITY CHECK only works if the amount that reaches it is
 * the amount the gateway actually settled. Two doors fed it something else,
 * and a capture below the order then confirmed a FULL booking in silence
 * (silent under-collection):
 *
 *   1. `order.paid` fell back to `order.entity.amount` — the order TOTAL — when
 *      Razorpay shipped no payment entity, so the guard compared the gateway
 *      against itself and always passed.
 *   2. The parity comparison sat BELOW the SUCCEEDED early-return, so a
 *      redelivery returned null before the mismatch was ever examined and the
 *      short-circuit was indistinguishable from agreement.
 *
 * These are end-to-end on purpose: the real `routeCapturedPayment` and the real
 * `handlePaymentSuccess` run, and only the transport edges (signature, dedupe
 * log, DB health) and the prisma/notification graph are mocked. Asserting on
 * the router's arguments alone would pass even if the guard below them were
 * still bypassed, which is exactly the bug being pinned.
 */

type PaymentStampArgs = {
  where: { paymentStatus?: string };
  data: {
    paymentStatus?: string;
    description?: string;
    gatewayPaymentId?: string | null;
  };
};

const mockParityState = {
  captureException: jest.fn((..._a: unknown[]): unknown => undefined),
  captureMessage: jest.fn((..._a: unknown[]): unknown => undefined),
  paymentUpdateMany: jest.fn(async (_args: PaymentStampArgs) => ({ count: 1 })),
  paymentFindUnique: jest.fn(
    (..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined),
  ),
  appointmentFindUnique: jest.fn(
    (..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined),
  ),
  txPaymentUpdate: jest.fn(async (..._a: unknown[]) => ({})),
  trialUpdateMany: jest.fn(async (..._a: unknown[]) => ({ count: 1 })),
  trialFindUnique: jest.fn((..._a: unknown[]): unknown => undefined),
  occurrenceFindMany: jest.fn(),
  prismaPaymentUpdate: jest.fn(async (..._a: unknown[]) => ({})),
  createEarningsFromPayment: jest.fn(),
  refundPayment: jest.fn(
    (..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined),
  ),
  refundBookingPayment: jest.fn((..._a: unknown[]): unknown => undefined),
  recordSystemEvent: jest.fn(async (..._a: unknown[]) => undefined),
  validateWebhookMetadata: jest.fn((..._a: unknown[]): unknown => undefined),
};

const mockParityTx = {
  payment: {
    findUnique: mockParityState.paymentFindUnique,
    updateMany: mockParityState.paymentUpdateMany,
    update: mockParityState.txPaymentUpdate,
  },
  appointment: { findUnique: mockParityState.appointmentFindUnique },
  trial: {
    updateMany: mockParityState.trialUpdateMany,
    findUnique: mockParityState.trialFindUnique,
  },
  appointmentOccurrence: { findMany: mockParityState.occurrenceFindMany },
};

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  setTag: jest.fn(),
  captureException: (...a: unknown[]) =>
    mockParityState.captureException(...a),
  captureMessage: (...a: unknown[]) => mockParityState.captureMessage(...a),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fmt: (s: TemplateStringsArray) => s.join(""),
  },
  getCurrentScope: () => ({ setTag: jest.fn() }),
}));

jest.mock("../../lib/db/serializable-retry", () => ({
  __esModule: true,
  withSerializableRetry: async (run: () => unknown) => run(),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (run: (tx: unknown) => unknown) => run(mockParityTx),
    payment: {
      update: (...a: unknown[]) =>
        mockParityState.prismaPaymentUpdate(...(a as [never])),
    },
    webhookEvent: {
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  },
}));

jest.mock("../../lib/payments/payouts", () => ({
  createEarningsFromPayment: (...a: unknown[]) =>
    mockParityState.createEarningsFromPayment(...a),
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  refundPayment: (...a: unknown[]) => mockParityState.refundPayment(...a),
}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (...a: unknown[]) =>
    mockParityState.refundBookingPayment(...a),
}));
jest.mock("../../lib/email", () => ({
  sendPaymentSuccessEmail: jest.fn(),
  sendPaymentFailedEmail: jest.fn(),
}));
jest.mock("../../lib/novu", () => ({
  notifyPaymentSuccess: jest.fn(),
  notifyPaymentFailed: jest.fn(),
  notifyAppointmentBooked: jest.fn(),
}));
jest.mock("../../lib/referrals/service", () => ({
  processQualifyingAction: jest.fn(),
  processConsultantBookingReferral: jest.fn(),
}));
jest.mock("../../actions/stream/chat/event-channel.action", () => ({
  addUserToEventChannel: jest.fn(),
}));
jest.mock("../../actions/stream/chat/channel.action", () => ({
  createDirectMessageChannel: jest.fn(),
}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { info: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: (...a: unknown[]) =>
    mockParityState.recordSystemEvent(...(a as [never])),
  recordSystemErrorSafe: (...a: unknown[]) =>
    mockParityState.recordSystemEvent(...(a as [never])),
  recordSystemEventSafe: (...a: unknown[]) =>
    mockParityState.recordSystemEvent(...(a as [never])),
}));
jest.mock("../../schemas/webhooks/metadata", () => ({
  normalizeLegacySlotKeys: (m: unknown) => m,
  validateWebhookMetadata: (...a: unknown[]) =>
    mockParityState.validateWebhookMetadata(...a),
}));
jest.mock("../../lib/payments/core/razorpay", () => ({}));
jest.mock("../../lib/payments/webhooks/overage-handlers", () => ({
  handleOverageMemberSuccess: jest.fn(),
  handleOverageMemberFailure: jest.fn(),
}));
jest.mock("../../lib/payments/webhooks/recording-purchase", () => ({
  handleRecordingPurchaseSuccess: jest.fn(),
  handleRecordingPurchaseFailure: jest.fn(),
}));

jest.mock("../../app/api/webhooks/utils", () => {
  const realHandlers = jest.requireActual("../../lib/payments/webhooks/handlers");
  const noopAsync = () => jest.fn(async () => undefined);
  return {
    __esModule: true,
    handlePaymentSuccess: realHandlers.handlePaymentSuccess,
    handlePaymentFailure: noopAsync(),
    handleOrgPaymentSuccess: noopAsync(),
    handleOrgPaymentFailure: noopAsync(),
    handleRefundCreated: noopAsync(),
    handleDisputeCreated: noopAsync(),
    handleDisputeUpdated: noopAsync(),
    handleRazorpayPayoutWebhook: noopAsync(),
    DeferSignal: class DeferSignal {},
    isDbHealthy: jest.fn(async () => true),
    logWebhookEvent: jest.fn(async () => ({
      isNew: true,
      claim: { id: "we1" },
    })),
    markWebhookEventProcessed: noopAsync(),
  };
});

import { processRazorpayWebhookEvent } from "../../app/api/webhooks/razorpay-dispatch";

const {
  captureException,
  paymentUpdateMany,
  paymentFindUnique,
  appointmentFindUnique,
  createEarningsFromPayment,
  refundPayment,
  validateWebhookMetadata,
} = mockParityState;

const pendingPayment = {
  id: "pay1",
  paymentIntent: "pi_capture_1",
  amount: 10000,
  paymentStatus: "PENDING",
  userId: "u1",
  currency: "INR",
  appointmentId: "appt1",
  user: { email: "buyer@example.com", name: "Buyer", consulteeProfile: {} },
};

function orderPaidEvent(
  orderTotalPaise: number,
  withPaymentEntity: boolean,
  capturedPaise: number = orderTotalPaise,
) {
  return {
    entity: "event",
    account_id: "acc_1",
    event: "order.paid",
    contains: ["payment"],
    created_at: 1,
    payload: {
      order: {
        entity: {
          id: "order_1",
          entity: "order",
          amount: orderTotalPaise,
          amount_paid: orderTotalPaise,
          amount_due: 0,
          currency: "INR",
          receipt: null,
          offer_id: null,
          status: "paid",
          attempts: 1,
          notes: { appointmentType: "CONSULTATION" },
          created_at: 1,
        },
      },
      ...(withPaymentEntity
        ? {
            payment: { entity: { id: "pay_x", amount: capturedPaise } },
          }
        : {}),
    },
  };
}

function expectNoMismatchStamp() {
  expect(
    paymentUpdateMany.mock.calls.find((c) =>
      String(c[0].data.description ?? "").includes("≠"),
    ),
  ).toBeUndefined();
}

beforeEach(() => {
  jest.clearAllMocks();
  paymentUpdateMany.mockImplementation(async () => ({ count: 1 }));
  validateWebhookMetadata.mockImplementation(() => undefined);
  refundPayment.mockResolvedValue({ id: "rfnd1" });
  appointmentFindUnique.mockResolvedValue(null);
  paymentFindUnique.mockResolvedValue(pendingPayment);
});

describe("order.paid must not pass the order TOTAL as a captured amount", () => {
  it("withholds the amount when Razorpay ships no payment entity, so parity is skipped not faked", async () => {
    paymentFindUnique.mockResolvedValue({
      ...pendingPayment,
      paymentIntent: "order_1",
    });

    await processRazorpayWebhookEvent(
      orderPaidEvent(9999, false) as never,
      "order.paid",
      "evt_rzp_1",
    );

    expectNoMismatchStamp();
    expect(refundPayment).not.toHaveBeenCalled();
    expect(appointmentFindUnique).toHaveBeenCalled();
  });

  it("still uses the payment entity's amount when Razorpay ships one", async () => {
    paymentFindUnique.mockResolvedValue({
      ...pendingPayment,
      paymentIntent: "order_1",
    });

    await processRazorpayWebhookEvent(
      orderPaidEvent(10000, true) as never,
      "order.paid",
      "evt_rzp_2",
    );

    expectNoMismatchStamp();
    expect(appointmentFindUnique).toHaveBeenCalled();
  });
});

describe("a redelivery still re-validates the captured amount", () => {
  const succeededPayment = {
    ...pendingPayment,
    paymentIntent: "order_1",
    paymentStatus: "SUCCEEDED",
    appointmentId: "appt1",
  };

  it("trips the parity check on a mismatched redelivery instead of short-circuiting", async () => {
    paymentFindUnique.mockResolvedValue(succeededPayment);

    await processRazorpayWebhookEvent(
      orderPaidEvent(10000, true, 6000) as never,
      "order.paid",
      "evt_rzp_redeliver_1",
    );

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(String(captureException.mock.calls[0][0])).toContain(
      "Capture amount mismatch",
    );
    expect(paymentUpdateMany).not.toHaveBeenCalled();
    expect(refundPayment).not.toHaveBeenCalled();
    expect(appointmentFindUnique).not.toHaveBeenCalled();
    expect(createEarningsFromPayment).not.toHaveBeenCalled();
  });

  it("is a no-op on a matching redelivery", async () => {
    paymentFindUnique.mockResolvedValue(succeededPayment);

    await processRazorpayWebhookEvent(
      orderPaidEvent(10000, true) as never,
      "order.paid",
      "evt_rzp_redeliver_2",
    );

    expect(captureException).not.toHaveBeenCalled();
    expect(paymentUpdateMany).not.toHaveBeenCalled();
    expect(refundPayment).not.toHaveBeenCalled();
    expect(appointmentFindUnique).not.toHaveBeenCalled();
    expect(createEarningsFromPayment).not.toHaveBeenCalled();
  });
});
