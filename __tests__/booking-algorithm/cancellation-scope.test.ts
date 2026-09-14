/**
 * @jest-environment node
 */

/**
 * Cancellation is a whole-booking act. #1554 — a booking is ONE Appointment
 * row: the wrapper checkout created carries the Payment and the frozen terms,
 * and every held session is an occurrence row on it.
 *
 * Before the reset a subscription was a slot-less placeholder plus one
 * Appointment per session, and reading the payment off "the appointment we
 * were handed" found nothing, so cancelling a paid subscription refunded
 * NOTHING. The tier had the matching defect: it read the earliest slot of that
 * one appointment, COMPLETED sessions included.
 *
 * Pinned here:
 *  - the ref resolves to the one wrapper, by id when the caller has it
 *  - the tier reads the earliest UNDELIVERED occurrence of the booking
 *  - already-delivered sessions are counted, so the caller can refuse to guess
 *    a proration rule (#1006)
 *  - the "several payments" alarm is per payer, since a class wrapper carries
 *    one Payment per attendee
 */

const mockAppointmentFindFirst = jest.fn();
const mockRecordSystemError = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: {
      findFirst: (...a: unknown[]) => mockAppointmentFindFirst(...a),
    },
  },
}));

jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: (...a: unknown[]) => mockRecordSystemError(...a),
}));

import { PLATFORM_DEFAULT_TERMS } from "@/lib/payments/operations/cancellation-policy";
import {
  bookingAppointmentFilter,
  resolveBookingRefundContext,
} from "../../lib/booking/cancellation-scope";

const HOUR = 3_600_000;
const WRAPPER = "appt-wrapper";

function hoursFromNow(h: number) {
  return new Date(Date.now() + h * HOUR);
}

/** A stored policy version, in the shape `POLICY_TERMS_INCLUDE` selects. */
function policyRow(
  id: string,
  tiers: { hoursBefore: number; refundBps: number }[],
) {
  return {
    id,
    organizationId: null,
    version: 1,
    consultantInitiatedBps: 10_000,
    tiers,
  };
}

/**
 * A subscription mid-plan: session 1 delivered, sessions 2 and 3 still owed,
 * the money on the one wrapper they all hang off.
 */
function subscriptionRow() {
  return {
    id: WRAPPER,
    cancellationPolicy: null,
    payment: [{ id: "pay-1", amount: 100_000, refunds: [], disputes: [] }],
    occurrences: [
      { startsAt: hoursFromNow(-48), completionStatus: "COMPLETED" },
      { startsAt: hoursFromNow(72), completionStatus: "SCHEDULED" },
      { startsAt: hoursFromNow(96), completionStatus: "SCHEDULED" },
    ],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordSystemError.mockResolvedValue(undefined);
});

describe("bookingAppointmentFilter", () => {
  it("selects by id when the caller already holds the wrapper", () => {
    // #1554 — the id IS the booking; there is no sibling set to widen to.
    expect(
      bookingAppointmentFilter({
        appointmentId: WRAPPER,
        subscriptionId: "sub-1",
      }),
    ).toEqual({ id: WRAPPER });
  });

  it("selects the class's one wrapper by its parent link", () => {
    expect(bookingAppointmentFilter({ cohortId: "class-1" })).toEqual({
      cohortId: "class-1",
    });
  });

  it("resolves a lone id for trials and unlinked rows", () => {
    expect(bookingAppointmentFilter({ appointmentId: "appt-trial" })).toEqual({
      id: "appt-trial",
    });
  });

  it("refuses to select everything when nothing identifies the booking", () => {
    // An empty filter would have matched every appointment in the table.
    expect(() => bookingAppointmentFilter({})).toThrow(/no booking identifier/);
  });
});

describe("resolveBookingRefundContext", () => {
  it("finds the subscription's payment on the wrapper", async () => {
    mockAppointmentFindFirst.mockResolvedValue(subscriptionRow());

    const ctx = await resolveBookingRefundContext({
      appointmentId: WRAPPER,
      subscriptionId: "sub-1",
    });

    expect(ctx.paidPayment).toEqual({
      id: "pay-1",
      amountPaise: 100_000,
      refundablePaise: 100_000,
    });
  });

  it("times the tier off the next UNDELIVERED session of the booking", async () => {
    mockAppointmentFindFirst.mockResolvedValue(subscriptionRow());

    const ctx = await resolveBookingRefundContext({
      subscriptionId: "sub-1",
    });

    // Session 1 is 48h in the past. Reading the earliest slot outright gave a
    // negative value and therefore a 0% tier on a plan with sessions still owed.
    expect(ctx.hoursUntilNextSession).toBeGreaterThan(71);
    expect(ctx.hoursUntilNextSession).toBeLessThan(73);
  });

  it("counts what has been delivered and what is still owed", async () => {
    mockAppointmentFindFirst.mockResolvedValue(subscriptionRow());

    const ctx = await resolveBookingRefundContext({ subscriptionId: "sub-1" });

    // The caller refuses to auto-refund a partly-consumed plan on this (#1006).
    expect(ctx.sessionsCompleted).toBe(1);
    expect(ctx.sessionsRemaining).toBe(2);
  });

  it("treats a RESCHEDULED slot as still owed, not as delivered", async () => {
    mockAppointmentFindFirst.mockResolvedValue({
      id: WRAPPER,
      cancellationPolicy: null,
      payment: [{ id: "pay-1", amount: 100_000, refunds: [], disputes: [] }],
      occurrences: [
        { startsAt: hoursFromNow(30), completionStatus: "RESCHEDULED" },
      ],
    });

    const ctx = await resolveBookingRefundContext({ subscriptionId: "sub-1" });

    expect(ctx.sessionsRemaining).toBe(1);
    expect(ctx.sessionsCompleted).toBe(0);
    expect(ctx.hoursUntilNextSession).toBeGreaterThan(29);
  });

  it("reports no live session for a paid but unallocated subscription", async () => {
    mockAppointmentFindFirst.mockResolvedValue({
      id: WRAPPER,
      cancellationPolicy: null,
      payment: [{ id: "pay-1", amount: 100_000, refunds: [], disputes: [] }],
      occurrences: [],
    });

    const ctx = await resolveBookingRefundContext({ subscriptionId: "sub-1" });

    // null, not a negative number: "never scheduled" and "already started" are
    // different facts and only the caller can decide what each is worth.
    expect(ctx.hoursUntilNextSession).toBeNull();
    expect(ctx.paidPayment).not.toBeNull();
  });

  it("takes the terms stamped on the wrapper the buyer paid for", async () => {
    mockAppointmentFindFirst.mockResolvedValue({
      id: WRAPPER,
      cancellationPolicy: policyRow("policy-paid", [
        { hoursBefore: 48, refundBps: 9_000 },
      ]),
      payment: [{ id: "pay-1", amount: 100_000, refunds: [], disputes: [] }],
      occurrences: [],
    });

    const ctx = await resolveBookingRefundContext({ subscriptionId: "sub-1" });

    expect(ctx.policy.policyId).toBe("policy-paid");
    expect(ctx.policy.tiers).toEqual([{ hoursBefore: 48, refundPct: 90 }]);
  });

  it("reads a booking with no policy row at all as the platform ladder", async () => {
    mockAppointmentFindFirst.mockResolvedValue({
      id: WRAPPER,
      cancellationPolicy: null,
      payment: [{ id: "pay-1", amount: 100_000, refunds: [], disputes: [] }],
      occurrences: [],
    });

    const ctx = await resolveBookingRefundContext({ subscriptionId: "sub-1" });

    expect(ctx.policy).toEqual(PLATFORM_DEFAULT_TERMS);
  });

  it("scopes the payment lookup to one buyer for group events", async () => {
    mockAppointmentFindFirst.mockResolvedValue(null);

    await resolveBookingRefundContext({ cohortId: "class-1" }, "user-7");

    // Every attendee's Payment hangs off the same appointment, so an unscoped
    // lookup would refund whoever the DB returned first.
    expect(mockAppointmentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          payment: expect.objectContaining({
            where: expect.objectContaining({ userId: "user-7" }),
          }),
        }),
      }),
    );
  });

  it("reads the shared occurrences unscoped by buyer (#1554)", async () => {
    mockAppointmentFindFirst.mockResolvedValue(null);

    await resolveBookingRefundContext({ cohortId: "class-1" }, "user-7");

    // Every attendee of a class shares the appointment's occurrences, so
    // there is no per-buyer subset to scope to; the buyer filter lives on the
    // payment lookup instead.
    expect(mockAppointmentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          occurrences: expect.objectContaining({
            where: { deletedAt: null },
          }),
        }),
      }),
    );
  });

  it("leaves the slot lookup unscoped for a 1:1 booking", async () => {
    mockAppointmentFindFirst.mockResolvedValue(null);

    await resolveBookingRefundContext({ consultationId: "cons-1" });

    const where =
      mockAppointmentFindFirst.mock.calls[0][0].select.occurrences.where;
    expect(where).toEqual({ deletedAt: null });
  });

  it("escalates rather than silently refunding one of several payments", async () => {
    // Unreachable today — @@unique([userId, appointmentId]) allows one payment
    // per payer per appointment, and the CHARGE_MEMBER overage side-charge is
    // created with appointmentId: null precisely to avoid that clash. Which is
    // why it must be loud if it ever happens: the buyer would be refunded less
    // than they paid, and nothing else would say so.
    mockAppointmentFindFirst.mockResolvedValue({
      id: WRAPPER,
      cancellationPolicy: null,
      payment: [
        { id: "pay-1", amount: 100_000, refunds: [], disputes: [] },
        { id: "pay-2", amount: 40_000, refunds: [], disputes: [] },
      ],
      occurrences: [],
    });

    const ctx = await resolveBookingRefundContext({ subscriptionId: "sub-1" });

    expect(ctx.paidPayment?.id).toBe("pay-1");
    expect(mockRecordSystemError).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "PAYMENT",
        context: expect.objectContaining({
          paymentIds: ["pay-1", "pay-2"],
        }),
      }),
    );
  });

  it("stays quiet for the ordinary single-payment booking", async () => {
    mockAppointmentFindFirst.mockResolvedValue({
      id: WRAPPER,
      cancellationPolicy: null,
      payment: [{ id: "pay-1", amount: 100_000, refunds: [], disputes: [] }],
      occurrences: [],
    });

    await resolveBookingRefundContext({ subscriptionId: "sub-1" });

    expect(mockRecordSystemError).not.toHaveBeenCalled();
  });

  it("stays quiet for a class wrapper carrying one payment per attendee (#1554)", async () => {
    // Unscoped, a group wrapper legitimately holds N SUCCEEDED payments; the
    // alarm is about one PAYER being refunded less than they paid, so it only
    // has meaning once the lookup is scoped to a payer.
    mockAppointmentFindFirst.mockResolvedValue({
      id: WRAPPER,
      cancellationPolicy: null,
      payment: [
        { id: "pay-a", amount: 10_000, refunds: [], disputes: [] },
        { id: "pay-b", amount: 10_000, refunds: [], disputes: [] },
      ],
      occurrences: [],
    });

    await resolveBookingRefundContext({ cohortId: "class-1" });
    expect(mockRecordSystemError).not.toHaveBeenCalled();

    await resolveBookingRefundContext({ cohortId: "class-1" }, "user-a");
    expect(mockRecordSystemError).toHaveBeenCalledTimes(1);
  });

  it("resolves a consultation exactly as before — one row, one payment", async () => {
    mockAppointmentFindFirst.mockResolvedValue({
      id: "appt-c1",
      cancellationPolicy: null,
      payment: [{ id: "pay-c", amount: 250_000, refunds: [], disputes: [] }],
      occurrences: [
        { startsAt: hoursFromNow(5), completionStatus: "SCHEDULED" },
      ],
    });

    const ctx = await resolveBookingRefundContext({
      appointmentId: "appt-c1",
      consultationId: "cons-1",
    });

    expect(ctx.paidPayment).toEqual({
      id: "pay-c",
      amountPaise: 250_000,
      refundablePaise: 250_000,
    });
    expect(ctx.sessionsCompleted).toBe(0);
    expect(ctx.hoursUntilNextSession).toBeGreaterThan(4);
  });

  it("nets prior refunds and lost chargebacks out of the refundable balance", async () => {
    mockAppointmentFindFirst.mockResolvedValue({
      id: WRAPPER,
      cancellationPolicy: null,
      payment: [
        {
          id: "pay-1",
          amount: 100_000,
          refunds: [
            { amountPaise: 20_000, status: "SUCCEEDED" },
            { amountPaise: 5_000, status: "PENDING" },
            // Moved no money, so it must not reduce the balance.
            { amountPaise: 40_000, status: "FAILED" },
          ],
          disputes: [
            { amountPaise: 10_000, status: "LOST" },
            // The bank already returned this one, so it reduces the balance
            // exactly as a LOST verdict does.
            { amountPaise: 5_000, status: "CHARGE_REFUNDED" },
            // Still contested — nothing has been pulled yet.
            { amountPaise: 30_000, status: "UNDER_REVIEW" },
          ],
        },
      ],
      occurrences: [],
    });

    const ctx = await resolveBookingRefundContext({ subscriptionId: "sub-1" });

    // Callers tier the gross but must clamp to this, or the refund operation
    // rejects the whole request instead of paying the remainder.
    expect(ctx.paidPayment?.amountPaise).toBe(100_000);
    expect(ctx.paidPayment?.refundablePaise).toBe(60_000);
  });

  it("never reports a negative refundable balance", async () => {
    mockAppointmentFindFirst.mockResolvedValue({
      id: WRAPPER,
      cancellationPolicy: null,
      payment: [
        {
          id: "pay-1",
          amount: 100_000,
          refunds: [{ amountPaise: 100_000, status: "SUCCEEDED" }],
          disputes: [{ amountPaise: 100_000, status: "LOST" }],
        },
      ],
      occurrences: [],
    });

    const ctx = await resolveBookingRefundContext({ subscriptionId: "sub-1" });

    expect(ctx.paidPayment?.refundablePaise).toBe(0);
  });

  it("distinguishes never-scheduled from all-slots-terminal", async () => {
    // These two look identical through sessionsCompleted/sessionsRemaining —
    // both zero — but only the first means the consultant never held time.
    // Conflating them hands a full refund to anyone reading the booking after
    // a cancel has already terminalised its slots.
    mockAppointmentFindFirst.mockResolvedValue({
      id: WRAPPER,
      cancellationPolicy: null,
      payment: [{ id: "pay-1", amount: 100_000, refunds: [], disputes: [] }],
      occurrences: [],
    });
    expect(
      (await resolveBookingRefundContext({ subscriptionId: "s" })).slotsTotal,
    ).toBe(0);

    mockAppointmentFindFirst.mockResolvedValue({
      id: WRAPPER,
      cancellationPolicy: null,
      payment: [{ id: "pay-1", amount: 100_000, refunds: [], disputes: [] }],
      occurrences: [
        { startsAt: hoursFromNow(48), completionStatus: "CANCELLED" },
      ],
    });
    const cancelled = await resolveBookingRefundContext({
      subscriptionId: "s",
    });
    expect(cancelled.slotsTotal).toBe(1);
    expect(cancelled.sessionsRemaining).toBe(0);
    expect(cancelled.sessionsCompleted).toBe(0);
  });

  it("skips a soft-deleted wrapper", async () => {
    mockAppointmentFindFirst.mockResolvedValue(null);

    await resolveBookingRefundContext({ subscriptionId: "sub-1" });

    expect(mockAppointmentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { subscriptionId: "sub-1", deletedAt: null },
      }),
    );
  });
});
