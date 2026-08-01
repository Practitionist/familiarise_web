/**
 * @jest-environment node
 */

/**
 * Removing a paid attendee has to return their fee (#1003).
 *
 * The participant-removal endpoints moved the roster and left the money alone:
 * a consultant could pull a paying attendee out of a class or webinar and keep
 * the fee, with no refund, no earnings reversal and no notice to the attendee.
 * The moderation bulk-cancel has always refunded a removed attendee in full;
 * the interactive endpoints were the outlier.
 *
 * Pinned here:
 *  - the removed attendee's OWN payment is the one refunded, not the first row
 *    on an appointment every attendee's payment hangs off
 *  - the organiser's act settles at the consultant-initiated percentage
 *  - an org-funded seat goes through the rail-aware front door
 *  - a free seat and a failed refund both leave the removal standing
 */

const mockPaymentFindFirst = jest.fn();
const mockRefundBookingPayment = jest.fn();
const mockNotifyRefundProcessed = jest.fn();
const mockRecordSystemError = jest.fn();
const mockReportSentryError = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findFirst: (...a: unknown[]) => mockPaymentFindFirst(...a),
      findMany: jest.fn().mockResolvedValue([]),
    },
  },
}));

jest.mock("../../lib/payments/operations/booking-refund", () => ({
  isInternalFundedIntent: (i: string) => i.startsWith("org_"),
  refundBookingPayment: (...a: unknown[]) => mockRefundBookingPayment(...a),
}));

jest.mock("../../lib/payments/operations/refund", () => ({
  refundPayment: jest.fn(),
  RefundValidationError: class extends Error {
    constructor(
      m: string,
      public code: string,
    ) {
      super(m);
    }
  },
}));

jest.mock("../../lib/payments/operations/reversal-engine", () => ({
  applyReversal: jest.fn(),
}));

jest.mock("../../lib/novu", () => ({
  notifyRefundProcessed: (...a: unknown[]) => mockNotifyRefundProcessed(...a),
}));

jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: (...a: unknown[]) => mockRecordSystemError(...a),
}));

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...a: unknown[]) => mockReportSentryError(...a),
  reportSentryMessage: jest.fn(),
}));

import { refundRemovedAttendeeSeat } from "../../lib/payments/operations/event-refunds";

const ATTENDEE = "user-7";

function seat(paymentIntent: string) {
  return {
    id: "pay-seat",
    amount: 50_000,
    currency: "INR",
    organizationId: null,
    paymentIntent,
    appointment: { cancellationPolicySnapshot: null },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPaymentFindFirst.mockResolvedValue(seat("pay_ABC"));
  mockRefundBookingPayment.mockResolvedValue({
    refundId: "r1",
    amountRefundedPaise: 50_000,
    rail: "GATEWAY",
  });
  mockNotifyRefundProcessed.mockResolvedValue(undefined);
  mockRecordSystemError.mockResolvedValue(undefined);
});

describe("refundRemovedAttendeeSeat", () => {
  it("refunds the removed attendee's seat in full", async () => {
    const result = await refundRemovedAttendeeSeat({
      kind: "webinar",
      eventId: "web-1",
      attendeeUserId: ATTENDEE,
      initiatedByUserId: "consultant-1",
    });

    // Organiser-initiated, so the consultant-initiated tier applies whatever
    // the clock says — the attendee did not choose to leave.
    expect(result).toEqual({ amountRefundedPaise: 50_000, refundPct: 100 });
  });

  it("targets the removed attendee's own payment", async () => {
    await refundRemovedAttendeeSeat({
      kind: "class",
      eventId: "class-1",
      attendeeUserId: ATTENDEE,
      initiatedByUserId: "consultant-1",
    });

    // Every attendee's Payment hangs off the same appointment, so an unscoped
    // lookup would have refunded whoever the DB returned first.
    expect(mockPaymentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: ATTENDEE,
          appointment: { classId: "class-1" },
          paymentStatus: "SUCCEEDED",
        }),
      }),
    );
  });

  it("routes an org-funded seat through the rail-aware front door", async () => {
    mockPaymentFindFirst.mockResolvedValue(seat("org_wallet_1_a"));
    mockRefundBookingPayment.mockResolvedValue({
      refundId: "r1",
      amountRefundedPaise: 50_000,
      rail: "INTERNAL",
    });

    const result = await refundRemovedAttendeeSeat({
      kind: "webinar",
      eventId: "web-1",
      attendeeUserId: ATTENDEE,
      initiatedByUserId: "consultant-1",
    });

    expect(mockRefundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay-seat" }),
    );
    expect(result?.amountRefundedPaise).toBe(50_000);
  });

  it("mints nothing for a free seat", async () => {
    mockPaymentFindFirst.mockResolvedValue(null);

    const result = await refundRemovedAttendeeSeat({
      kind: "class",
      eventId: "class-1",
      attendeeUserId: ATTENDEE,
      initiatedByUserId: "consultant-1",
    });

    expect(result).toBeNull();
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });

  it("tells the attendee their money is coming back", async () => {
    await refundRemovedAttendeeSeat({
      kind: "webinar",
      eventId: "web-1",
      attendeeUserId: ATTENDEE,
      initiatedByUserId: "consultant-1",
    });

    expect(mockNotifyRefundProcessed).toHaveBeenCalledWith(
      ATTENDEE,
      expect.objectContaining({ amount: 50_000 }),
    );
  });

  it("leaves the removal standing and pages ops when the refund fails", async () => {
    mockRefundBookingPayment.mockRejectedValue(new Error("gateway down"));

    // Must not throw — the roster change has already committed.
    const result = await refundRemovedAttendeeSeat({
      kind: "class",
      eventId: "class-1",
      attendeeUserId: ATTENDEE,
      initiatedByUserId: "consultant-1",
    });

    expect(result).toEqual({ amountRefundedPaise: 0, refundPct: 0 });
    expect(mockReportSentryError).toHaveBeenCalled();
    expect(mockRecordSystemError).toHaveBeenCalled();
  });
});
