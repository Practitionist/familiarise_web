/**
 * @jest-environment node
 */

/**
 * The cancel route must actually refund. There was no test that it did.
 *
 * Both existing cancel-route suites stub `appointment.findMany -> []`, which
 * makes the payment lookup come back empty and kills the entire refund block —
 * so every check on those suites was compatible with the refund path being
 * dead. It was: resolving the booking context AFTER the cancel transaction
 * meant the transaction had already stamped every SCHEDULED/RESCHEDULED slot
 * CANCELLED, the "next undelivered session" came back empty, and every
 * consultee-initiated cancellation silently fell to the 0% tier.
 *
 * The prisma stub here models that ordering honestly: `appointment.findMany`
 * answers with live slots before `$transaction` runs and with CANCELLED slots
 * afterwards, exactly as the database would. A resolver called on the wrong
 * side of the transaction therefore scores 0% and these tests fail.
 */

const mockAppointmentFindUnique = jest.fn();
const mockAppointmentFindMany = jest.fn();
const mockPaymentFindMany = jest.fn();
const mockRefundBookingPayment = jest.fn();
const mockRecordSystemError = jest.fn();
const mockGetSession = jest.fn();

/** Flipped by the $transaction stub, mirroring the slot terminalisation. */
let txCommitted = false;

const txStub = {
  consultation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  subscription: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  webinar: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  class: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  slotOfAppointment: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
  rescheduleRequest: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => unknown) => {
      const out = await fn(txStub);
      // The cancel transaction terminalises every live slot. Anything reading
      // "which session is still owed" after this point sees nothing.
      txCommitted = true;
      return out;
    },
    appointment: {
      findUnique: (...a: unknown[]) => mockAppointmentFindUnique(...a),
      findMany: (...a: unknown[]) => mockAppointmentFindMany(...a),
    },
    payment: { findMany: (...a: unknown[]) => mockPaymentFindMany(...a) },
    dispute: { findFirst: jest.fn().mockResolvedValue(null) },
  },
}));

jest.mock("../../lib/auth-server", () => ({
  getSession: (...a: unknown[]) => mockGetSession(...a),
}));

jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (...a: unknown[]) => mockRefundBookingPayment(...a),
}));

jest.mock("../../lib/payments/operations/event-refunds", () => ({
  refundWholeEventPayments: jest.fn().mockResolvedValue({
    refundsIssued: 0,
    refundedPaise: 0,
    childRefundIds: [],
    failures: [],
  }),
}));

jest.mock("../../lib/novu", () => ({
  notifyAppointmentCancelled: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: (...a: unknown[]) => mockRecordSystemError(...a),
}));

jest.mock("../../lib/activity/log-activity", () => ({
  logConsultationCancelled: jest.fn().mockResolvedValue(undefined),
  logSubscriptionCancelled: jest.fn().mockResolvedValue(undefined),
}));

import { POST as cancelHandler } from "@/app/api/appointments/[appointmentId]/cancel/route";

const HOUR = 3_600_000;
const APPT = "appt-1";
const CONSULTANT_USER = "consultant-1";
const CONSULTEE_USER = "consultee-1";
const CONSULTANT_PROFILE = "cp-1";
const CONSULTEE_PROFILE = "ce-1";

/** ₹5,000. */
const GROSS = 500_000;

function makeParams(id: string) {
  return { params: Promise.resolve({ appointmentId: id }) };
}

function makeRequest(body?: Record<string, unknown>) {
  return new Request(`http://localhost/api/appointments/${APPT}/cancel`, {
    method: "POST",
    ...(body
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  }) as never;
}

function consultationAppointment() {
  return {
    id: APPT,
    appointmentType: "CONSULTATION",
    organizationId: null,
    consultationId: "cons-1",
    subscriptionId: null,
    cancellationPolicySnapshot: null,
    slotsOfAppointment: [{ startsAt: new Date(Date.now() + 120 * HOUR) }],
    consultation: {
      id: "cons-1",
      requestedById: CONSULTEE_PROFILE,
      consultationPlan: {
        title: "Strategy call",
        consultantProfileId: CONSULTANT_PROFILE,
        consultantProfile: { user: { id: CONSULTANT_USER, name: "Dr Who" } },
      },
      requestedBy: { user: { id: CONSULTEE_USER, name: "Ada" } },
    },
    subscription: null,
    webinar: null,
    class: null,
  };
}

function subscriptionAppointment() {
  return {
    ...consultationAppointment(),
    appointmentType: "SUBSCRIPTION",
    consultationId: null,
    subscriptionId: "sub-1",
    consultation: null,
    subscription: {
      id: "sub-1",
      requestedById: CONSULTEE_PROFILE,
      subscriptionPlan: {
        title: "Monthly plan",
        consultantProfileId: CONSULTANT_PROFILE,
        consultantProfile: { user: { id: CONSULTANT_USER, name: "Dr Who" } },
      },
      requestedBy: { user: { id: CONSULTEE_USER, name: "Ada" } },
    },
  };
}

/**
 * The booking as the database would answer it: live slots until the cancel
 * transaction commits, terminalised afterwards.
 */
function bookingRows(opts: {
  liveSlotHours?: number[];
  completedSlotHours?: number[];
  paymentRefunds?: { amountPaise: number; status: string }[];
  noPayment?: boolean;
}) {
  const live = (opts.liveSlotHours ?? []).map((h) => ({
    startsAt: new Date(Date.now() + h * HOUR),
    completionStatus: txCommitted ? "CANCELLED" : "SCHEDULED",
  }));
  const done = (opts.completedSlotHours ?? []).map((h) => ({
    startsAt: new Date(Date.now() + h * HOUR),
    completionStatus: "COMPLETED",
  }));
  return [
    {
      id: APPT,
      cancellationPolicySnapshot: null,
      payment: opts.noPayment
        ? []
        : [
            {
              id: "pay-1",
              amount: GROSS,
              refunds: opts.paymentRefunds ?? [],
              disputes: [],
            },
          ],
      slotsOfAppointment: [...done, ...live],
    },
  ];
}

function sessionAs(role: "consultant" | "consultee") {
  return {
    user:
      role === "consultant"
        ? {
            id: CONSULTANT_USER,
            name: "Dr Who",
            consultantProfileId: CONSULTANT_PROFILE,
            consulteeProfileId: null,
          }
        : {
            id: CONSULTEE_USER,
            name: "Ada",
            consultantProfileId: null,
            consulteeProfileId: CONSULTEE_PROFILE,
          },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  txCommitted = false;
  txStub.consultation.updateMany.mockResolvedValue({ count: 1 });
  txStub.subscription.updateMany.mockResolvedValue({ count: 1 });
  txStub.slotOfAppointment.updateMany.mockResolvedValue({ count: 2 });
  txStub.rescheduleRequest.updateMany.mockResolvedValue({ count: 0 });
  mockPaymentFindMany.mockResolvedValue([]);
  mockRecordSystemError.mockResolvedValue(undefined);
  mockRefundBookingPayment.mockImplementation(
    async ({ amountPaise }: { amountPaise: number }) => ({
      refundId: "r1",
      amountRefundedPaise: amountPaise,
      rail: "GATEWAY",
    }),
  );
});

describe("a consultee cancelling a paid consultation gets their money back", () => {
  it("refunds the full amount five days out", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(res.status).toBe(200);
    // The regression: resolved after the transaction this was 0.
    expect(body.refund).toEqual({
      amountRefundedPaise: GROSS,
      refundPct: 100,
    });
    expect(mockRefundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay-1", amountPaise: GROSS }),
    );
  });

  it("applies the mid-tier inside the day", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [6] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(body.refund.refundPct).toBe(50);
    expect(body.refund.amountRefundedPaise).toBe(GROSS / 2);
  });

  it("refunds nothing inside the final two hours", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [1] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(body.refund).toEqual({ amountRefundedPaise: 0, refundPct: 0 });
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });

  it("clamps to what is still refundable after an earlier partial refund", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({
        liveSlotHours: [120],
        paymentRefunds: [{ amountPaise: 200_000, status: "SUCCEEDED" }],
      }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    // 100% of gross would exceed the balance, the operation would reject the
    // whole request, and the buyer would get nothing instead of the remainder.
    expect(body.refund.amountRefundedPaise).toBe(GROSS - 200_000);
  });
});

describe("a consultant cancelling always refunds in full", () => {
  it("ignores the clock", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultant"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [1] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(body.refund.refundPct).toBe(100);
    expect(body.refund.amountRefundedPaise).toBe(GROSS);
  });
});

describe("subscriptions", () => {
  it("refunds an untouched plan on the next session's tier", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(subscriptionAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [72, 96, 120] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(body.refund.amountRefundedPaise).toBe(GROSS);
  });

  it("refunds a paid but never-allocated plan in full", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(subscriptionAppointment());
    mockAppointmentFindMany.mockImplementation(async () => bookingRows({}));

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    // No session was ever scheduled, so notice is infinite, not negative.
    // Treating it as negative made cancelling EARLIER score worse than later.
    expect(body.refund.refundPct).toBe(100);
    expect(body.refund.amountRefundedPaise).toBe(GROSS);
  });

  it("escalates a partly-consumed plan instead of guessing a proration", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(subscriptionAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ completedSlotHours: [-48], liveSlotHours: [72, 96] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(body.refund.requiresManualReview).toBe(true);
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
    // A Sentry breadcrumb is not a queue — this has to be durable.
    expect(mockRecordSystemError).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "PAYMENT",
        context: expect.objectContaining({
          sessionsCompleted: 1,
          sessionsRemaining: 2,
        }),
      }),
    );
  });
});

describe("failure modes leave the cancellation standing", () => {
  it("reports a failed refund rather than swallowing it", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120] }),
    );
    mockRefundBookingPayment.mockRejectedValue(new Error("gateway down"));

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.refund).toEqual({ amountRefundedPaise: 0, refundPct: 100 });
  });

  it("mints no refund for a free booking", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120], noPayment: true }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(body.refund).toBeNull();
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });

  it("does not refund when the cancel loses its CAS race", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120] }),
    );
    txStub.consultation.updateMany.mockResolvedValue({ count: 0 });

    const res = await cancelHandler(makeRequest(), makeParams(APPT));

    expect(res.status).toBe(409);
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });
});
