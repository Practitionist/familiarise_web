/**
 * @jest-environment node
 */

// Invariant: cancel stamps a durable refund-owed marker inside its tx and refunds post-commit under dedupeKey `cancel:<appointmentId>:<paymentId>`.

import "../../booking-algorithm/setup";

const APPT = "clzzzzzzz000appointment1";
const QUOTED_PAISE = 50_000;

const txCalls: { model: string; op: string; arg: unknown }[] = [];
const tracked = (model: string, op: string) =>
  jest.fn(async (arg: unknown) => {
    txCalls.push({ model, op, arg });
    return { count: 1 };
  });
const makeTx = () => ({
  appointment: {
    update: tracked("appointment", "update"),
    updateMany: tracked("appointment", "updateMany"),
  },
  payment: {
    update: tracked("payment", "update"),
    updateMany: tracked("payment", "updateMany"),
    findMany: async () => [],
    count: async () => 0,
  },
  // The owed-refund stamp cancels the unsent payouts that batched the payment's earnings; none here.
  consultantEarnings: { findMany: async () => [] },
  organizationEarnings: { findMany: async () => [] },
  consultation: { findUnique: async () => ({ status: "SCHEDULED" }) },
  streamRevocationRetry: createMockRevocationRetryTable(),
});

const appointmentRow = {
  id: APPT,
  organizationId: null,
  appointmentType: "CONSULTATION",
  consultationId: "cons-1",
  subscriptionId: null,
  consultation: {
    id: "cons-1",
    requestedById: "consultee-profile",
    consultationPlan: {
      id: "plan-1",
      title: "Plan",
      organizationId: null,
      consultantProfileId: "consultant-profile",
      consultantProfile: { user: { id: "u-consultant", name: "C" } },
    },
    requestedBy: { user: { id: "u-consultee", name: "E" } },
  },
  subscription: null,
  webinar: null,
  class: null,
  occurrences: [{ startsAt: new Date("2030-01-01T10:00:00Z") }],
};

jest.mock("../../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findUnique: async () => appointmentRow },
    membership: { findUnique: async () => null },
    payment: { updateMany: async () => ({ count: 1 }) },
    refund: { findUnique: async () => null },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(makeTx()),
  },
}));
jest.mock("../../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: async () => ({
    session: {
      user: {
        id: "u-consultee",
        role: "CONSULTEE",
        consulteeProfileId: "consultee-profile",
        consultantProfileId: null,
        name: "E",
      },
    },
  }),
  isPrivileged: () => false,
}));
jest.mock("../../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: async () => null,
  eventMutationLimiter: {},
}));
jest.mock("../../../utils/appointmentlock", () => ({
  __esModule: true,
  AppointmentBusyError: class extends Error {},
  BookingLockUnavailableError: class extends Error {},
  withAppointmentLock: async (_id: string, fn: () => Promise<unknown>) => fn(),
  renewAppointmentLock: async () => undefined,
  withEventCheckoutLock: async (
    _key: unknown,
    fn: (renew: () => Promise<void>) => Promise<unknown>,
  ) => fn(async () => undefined),
}));
jest.mock("../../../lib/booking/participants", () => ({
  __esModule: true,
  liveParticipant: () => ({}),
  paidParticipant: () => ({}),
  transitionParticipant: async () => 1,
}));
jest.mock("../../../lib/booking/transitions", () => ({
  __esModule: true,
  CANCELLABLE_FROM: ["SCHEDULED"],
  CLASS_EVENT_ALLOWED_FROM: { CANCELLED: [] },
  EVENT_ALLOWED_FROM: { CANCELLED: [] },
  SLOT_RESCHEDULABLE_FROM: ["SCHEDULED"],
  transitionClassEvent: jest.fn(),
  transitionConsultationRequest: jest.fn(async () => 1),
  transitionOccurrenceCompletion: jest.fn(async () => 1),
  transitionSubscriptionRequest: jest.fn(),
  transitionWebinarEvent: jest.fn(),
}));
jest.mock("../../../lib/booking/backup-interest", () => ({
  __esModule: true,
  flushBackupInterestNotices: async () => undefined,
  stageNoticesForAppointmentHolds: async () => null,
}));
jest.mock("../../../lib/booking/reschedule-decline", () => ({
  __esModule: true,
  declineOpenReschedules: async () => undefined,
}));
jest.mock("../../../lib/booking/cancellation-scope", () => ({
  __esModule: true,
  readCancelWindowState: async () => "BEFORE",
  resolveBookingRefundContext: async () => ({
    windowState: "BEFORE",
    unsettledVoidIds: [],
    alreadyRefundedPaise: 0,
    policy: {},
    hoursUntilNextSession: 100,
    slotsTotal: 1,
    sessionsRemaining: 1,
    sessionsTotal: 1,
    sessionsCompleted: 0,
    scheduledStarts: [],
    paidPayment: {
      id: "pay-1",
      amountPaise: 100_000,
      refundablePaise: 100_000,
      paymentIntent: "order_abc",
    },
  }),
}));
jest.mock("../../../lib/payments/operations/cancellation-policy", () => ({
  __esModule: true,
  quoteBookingRefund: () => ({
    refundPct: 50,
    tierRefundPct: 50,
    refundPaise: 50_000,
    creditRestoresInFull: false,
  }),
}));
const refundBookingPayment = jest.fn();
jest.mock("../../../lib/payments/operations/booking-refund", () => ({
  __esModule: true,
  refundBookingPayment: (...a: unknown[]) => refundBookingPayment(...a),
}));
jest.mock("../../../lib/payments/operations/refund", () => ({
  __esModule: true,
  findDedupedRefund: async () => null,
  isModelledRefundRefusal: () => false,
  RefundGatewayError: class extends Error {},
  RefundValidationError: class extends Error {},
}));
jest.mock("../../../lib/payments/operations/event-refunds", () => ({
  __esModule: true,
  classSeriesLedgers: async () => null,
  refundWholeEventPayments: async () => null,
  stampWholeEventRefundsOwed: async () => new Map(),
}));
jest.mock("../../../lib/payments/dispute-guard", () => ({
  __esModule: true,
  hasActiveDisputeForAppointment: async () => false,
}));
jest.mock("../../../lib/booking/subscription-cycle", () => ({
  __esModule: true,
  stampTranchesOnCancel: async () => undefined,
}));
jest.mock("../../../lib/enterprise/system-events", () => ({
  __esModule: true,
  recordSystemErrorSafe: jest.fn(async () => undefined),
}));
jest.mock("../../../lib/observability/report", () => ({
  __esModule: true,
  reportSentryError: jest.fn(),
}));
jest.mock("../../../lib/enterprise/suspended-member-sessions", () => ({
  __esModule: true,
  isSuspendedInFundingOrg: async () => false,
  membershipSuspendedResponse: jest.fn(),
}));
jest.mock("../../../lib/booking/org-actor", () => ({
  __esModule: true,
  recordActForOrg: jest.fn(),
  resolveOrgActor: async () => null,
}));
jest.mock("../../../lib/collaborators/recipients", () => ({
  __esModule: true,
  collaboratorUserIds: async () => [],
}));
jest.mock("../../../lib/novu/stage-then-attempt", () => ({
  __esModule: true,
  flushNotificationsAfter: async () => undefined,
}));
jest.mock("../../../lib/email", () => ({
  __esModule: true,
  refundOnItsWay: () => "refund",
}));
jest.mock("../../../lib/email/senders/booking", () => ({
  __esModule: true,
  stageAppointmentCancelledEmail: async () => [],
}));
import { NextRequest } from "next/server";
import { notifyAppointmentCancelled } from "../../../lib/novu";
import { POST } from "../../../app/api/appointments/[appointmentId]/cancel/route";
import { createMockRevocationRetryTable } from "../../fixtures/stream-mocks";

type Write = { data?: Record<string, unknown> };

// Implementation-agnostic: a refundOwed* column on either row, or a Payment `Auto-refund pending:` description.
function owedMarkerWrites() {
  return txCalls.filter(({ model, arg }) => {
    const data = (arg as Write).data ?? {};
    if ("refundOwedPaise" in data || "refundOwedKey" in data) return true;
    return (
      model === "payment" &&
      typeof data.description === "string" &&
      data.description.startsWith("Auto-refund pending:")
    );
  });
}

beforeEach(() => {
  txCalls.length = 0;
  jest.mocked(notifyAppointmentCancelled).mockResolvedValue([]);
  refundBookingPayment.mockReset();
  refundBookingPayment.mockRejectedValue(new Error("gateway 503"));
});

const cancel = () =>
  POST(new NextRequest("http://localhost/x", { method: "POST" }), {
    params: Promise.resolve({ appointmentId: APPT }),
  });

describe("cancel route: refund owed durability", () => {
  it("stamps an owed marker with the quoted amount inside the cancel tx", async () => {
    const res = await cancel();
    expect(res.status).toBe(200);

    const markers = owedMarkerWrites();
    expect(markers.length).toBeGreaterThan(0);
    expect(JSON.stringify(markers.map((m) => m.arg))).toContain(
      String(QUOTED_PAISE),
    );
  });

  it("refunds post-commit under dedupeKey cancel:<appointmentId>", async () => {
    await cancel();
    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        amountPaise: QUOTED_PAISE,
        dedupeKey: `cancel:${APPT}:pay-1`,
      }),
    );
  });
});
