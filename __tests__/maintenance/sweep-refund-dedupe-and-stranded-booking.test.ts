/**
 * @jest-environment node
 */

/**
 * P0-4 — every automatic refund in the two maintenance sweeps carries a
 * `dedupeKey`, so `Refund`'s unique index is the at-most-once guarantee.
 *
 * Unkeyed, the only guard left was `refundPayment`'s re-derivation of the
 * refundable balance inside its own Serializable transaction. That is a
 * read-then-write, and `Refund` carries no unique constraint on `paymentId`, so
 * two concurrent unkeyed runs — which an expired `cron:lock:` grant allows, and
 * which is the exact situation these two jobs are locked for — both read
 * `refundable = amount`, both pass, and both create a Refund row. The money
 * leaves twice. `with-cron-lock` says the CAS guards, not the lock, are the
 * correctness backstop; an unkeyed refund was the one place that was untrue.
 *
 * The key is derived from the arm and the payment id ONLY, so a re-run produces
 * the identical string (a key that varied per run would never dedupe anything),
 * and each arm owns its own namespace so two sweeps that legitimately refund the
 * same payment for different reasons do not read each other's refund as their
 * own completed work.
 *
 * P0-3 — the paid-but-unallocated 48 h arm refuses a booking parked by a
 * declined reschedule. A reschedule releases a slot IN PLACE
 * (`isTentative: true` + `RESCHEDULED`) and a decline deliberately leaves it
 * released; a whole-booking reschedule also leaves the parent PENDING, which is
 * precisely the shape that arm selects. Without the exclusion a paid booking was
 * EXPIRED and fully refunded with nobody having cancelled it. The predicate is
 * stated on the LIVE SLOT, so it holds whatever parent status the reschedule work
 * chooses, and it rides the CAS WHERE as well as the cohort read.
 */

import { AppointmentStatus, PaymentStatus } from "@prisma/client";

const refundBookingPayment = jest.fn();
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  __esModule: true,
  refundBookingPayment: (...a: unknown[]) =>
    refundBookingPayment(...(a as [never])),
}));

// The no-show detector corroborates against Stream before moving money; one
// distinct participant is Stream agreeing only the consultee was ever there.
jest.mock("../../lib/stream/call-presence", () => ({
  __esModule: true,
  getCallPresenceEvidence: jest.fn(async () => ({
    unique: 1,
    maxConcurrent: 1,
  })),
}));

jest.mock("../../lib/enterprise/system-events", () => {
  const recordSystemError = jest.fn(async () => undefined);
  return {
    __esModule: true,
    recordSystemError,
    recordSystemErrorSafe: recordSystemError,
  };
});

jest.mock("../../lib/support/create-ticket", () => ({
  __esModule: true,
  createTicket: jest.fn(async () => ({ id: "ticket-1" })),
  createSupportTicket: jest.fn(async () => ({ id: "ticket-1" })),
}));

jest.mock("../../lib/novu/service", () => ({
  __esModule: true,
  notifyUnscheduledSubscriptionNudge: jest.fn(async () => ({ success: true })),
  notifyAppointmentCancelled: jest.fn(async () => undefined),
  notifyRefundProcessed: jest.fn(async () => undefined),
}));

jest.mock("../../lib/novu/outbox", () => ({
  __esModule: true,
  deriveTransactionId: (...parts: unknown[]) => parts.join("|"),
}));

jest.mock("../../lib/novu/stage-bell", () => ({
  __esModule: true,
  stageBell: jest.fn(async () => undefined),
}));

jest.mock("../../lib/email", () => ({
  __esModule: true,
  EMAIL_BUDGET_MS: { JOB: 1 },
  refundOnItsWay: (paise: number) => `₹${paise / 100}`,
  SUBSCRIPTION_UNSCHEDULED_NUDGE_EMAIL_TYPE: "SUB_NUDGE",
  unscheduledNudgeEntityRef: (id: string, s: number) => `sub:${id}:${s}`,
  sendUnscheduledSubscriptionNudgeEmail: jest.fn(async () => ({ sent: 1 })),
  sendAppointmentCancelledEmail: jest.fn(async () => ({ sent: 1 })),
  sendRefundProcessedEmail: jest.fn(async () => ({ sent: 1 })),
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  withCronLock: (_key: string, _opts: unknown, fn: () => unknown) => fn(),
  LONG_JOB_TTL_MS: 35 * 60 * 1000,
}));

jest.mock("../../lib/prisma", () => {
  const db: Record<string, unknown> = {
    consultation: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    subscription: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    appointment: { findMany: jest.fn().mockResolvedValue([]) },
    appointmentOccurrence: {
      findMany: jest.fn().mockResolvedValue([]),
      updateManyAndReturn: jest.fn().mockResolvedValue([]),
    },
    payment: { findMany: jest.fn().mockResolvedValue([]) },
    refund: { findMany: jest.fn().mockResolvedValue([]) },
    failedEmail: { findMany: jest.fn().mockResolvedValue([]) },
    supportTicket: { findFirst: jest.fn().mockResolvedValue(null) },
    maintenanceWindow: { findMany: jest.fn().mockResolvedValue([]) },
    windowBackupInterest: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    bookingStatusHistory: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    notificationOutbox: {
      upsert: jest.fn(async () => ({})),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $disconnect: jest.fn(),
  };
  // Every arm runs its CAS callback against this same client.
  db.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { __esModule: true, default: db };
});

import prisma from "../../lib/prisma";
import { expireStaleRequests } from "../../scripts/appointments/expire-stale-requests";
import { detectConsultantNoShows } from "../../scripts/appointments/detect-consultant-no-shows";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>> & {
  $transaction: jest.Mock;
};

const HOUR = 60 * 60 * 1000;
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR);

/** Every dedupeKey the two sweeps handed the front door, in call order. */
const refundKeys = (): string[] =>
  refundBookingPayment.mock.calls.map((c) => String(c[0].dedupeKey));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A paid, stale wrapper whose consultant never allocated a session. */
function paidPlanRow(id: string) {
  return {
    id,
    requestedAt: hoursAgo(40),
    requestedBy: { user: { id: "u-buyer", name: "Buyer" } },
    subscriptionPlan: {
      title: "Mentorship",
      consultantProfile: {
        id: "cp-1",
        user: { id: "u-expert", name: "Expert" },
      },
    },
    appointment: {
      id: "apt-1",
      organizationId: null,
      occurrences: [],
      payment: [],
    },
  };
}

/** A paid, stale PENDING consultation, consultant never answered. */
function pendingConsultationRow(id: string) {
  return {
    id,
    requestedAt: hoursAgo(72),
    appointment: { id: "apt-c", organizationId: null, occurrences: [] },
    requestedBy: { user: { id: "u-buyer", name: "Buyer" } },
    consultationPlan: {
      title: "Career strategy",
      consultantProfile: { user: { name: "Expert" } },
    },
  };
}

/** A candidate the no-show detector will classify as a real consultant no-show. */
function noShowCandidate(paymentId: string) {
  return {
    id: "cons-1",
    consultationPlan: {
      title: "Career strategy",
      consultantProfile: { userId: "user-consultant", user: { name: "C" } },
    },
    requestedBy: { userId: "user-consultee", user: { name: "K" } },
    appointment: {
      id: "apt-1",
      organizationId: null,
      payment: [
        {
          id: paymentId,
          amount: 150000,
          currency: "INR",
          paymentStatus: "SUCCEEDED",
        },
      ],
      occurrences: [
        {
          startsAt: hoursAgo(4),
          endsAt: hoursAgo(3),
          presences: [
            {
              userId: "user-consultee",
              joinedAt: hoursAgo(4),
              leftAt: hoursAgo(3),
            },
          ],
          meeting: {
            streamCallId: "call-1",
            endedAt: hoursAgo(3),
            endedReason: "call_ended",
            attendances: [{ userId: "user-consultee" }],
          },
        },
      ],
    },
  };
}

/** The 48 h arm is the cohort that names a capture clock; the others do not. */
function isPaidUnallocatedCohort(where: Record<string, unknown>): boolean {
  const clauses = where.AND as Record<string, unknown>[] | undefined;
  return (
    Array.isArray(clauses) &&
    clauses.some((c) => JSON.stringify(c).includes("capturedAt"))
  );
}

/** Only the 30-day PENDING cohort filters on requestedAt among the PENDING reads. */
function isThirtyDayPendingCohort(where: Record<string, unknown>): boolean {
  return where.status === AppointmentStatus.PENDING && "requestedAt" in where;
}

/** The one released-still-awaiting-replacement occurrence, as the slot states it. */
const RELEASED_SLOT = {
  NOT: {
    appointment: {
      occurrences: {
        some: { completionStatus: "RESCHEDULED", deletedAt: null },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// P0-4 — the keys
// ---------------------------------------------------------------------------

describe("P0-4 — every automatic sweep refund is keyed", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    refundBookingPayment.mockResolvedValue({
      amountRefundedPaise: 150000,
      rail: "GATEWAY",
    });
    db.consultation.findMany.mockResolvedValue([]);
    db.subscription.findMany.mockResolvedValue([]);
    db.appointment.findMany.mockResolvedValue([]);
    db.payment.findMany.mockResolvedValue([]);
    db.refund.findMany.mockResolvedValue([]);
    db.bookingStatusHistory.findMany.mockResolvedValue([]);
    db.bookingStatusHistory.create.mockResolvedValue({});
    db.notificationOutbox.findMany.mockResolvedValue([]);
    db.failedEmail.findMany.mockResolvedValue([]);
    db.subscription.updateMany.mockResolvedValue({ count: 1 });
    db.consultation.updateMany.mockResolvedValue({ count: 1 });
  });

  it("keys the PENDING-consultation expiry arm on its own arm name", async () => {
    db.consultation.findMany.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) =>
        where.status === AppointmentStatus.PENDING
          ? [pendingConsultationRow("cons-p")]
          : [],
    );
    db.appointment.findMany.mockResolvedValue([
      { id: "apt-c", payment: [{ id: "pay-1", paymentStatus: "SUCCEEDED" }] },
    ]);

    await expireStaleRequests();

    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
    expect(refundBookingPayment.mock.calls[0][0]).toMatchObject({
      paymentId: "pay-1",
      dedupeKey: "pending-consultation:pay-1",
    });
  });

  // The APPROVED-unallocated arm is the immortal cohort: APPROVED, zero
  // confirmed sessions, stale. It is a different arm from the PENDING expiry
  // above, so the same payment must not collide.
  it("keys the APPROVED-unallocated arm separately from the PENDING arm", async () => {
    db.subscription.findMany.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) =>
        where.status === AppointmentStatus.APPROVED ? [{ id: "sub-a" }] : [],
    );
    db.appointment.findMany.mockResolvedValue([
      { id: "apt-a", payment: [{ id: "pay-1", paymentStatus: "SUCCEEDED" }] },
    ]);

    await expireStaleRequests();

    expect(refundKeys()).toContain("approved-unallocated:pay-1");
    expect(refundKeys()).not.toContain("pending-consultation:pay-1");
  });

  // Pinned for completeness: the PENDING-subscription arm cannot reach a
  // SUCCEEDED payment in production (its cohort carries
  // NOT: HAS_SUCCEEDED_PAYMENT), but the key it WOULD use has to stay distinct
  // from the APPROVED arm's — both are subscription arms, which is exactly why
  // the key cannot be built from the wrapper.
  it("keys the PENDING-subscription arm separately from the APPROVED arm", async () => {
    db.subscription.findMany.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) =>
        isThirtyDayPendingCohort(where) ? [paidPlanRow("sub-p")] : [],
    );
    db.appointment.findMany.mockResolvedValue([
      { id: "apt-p", payment: [{ id: "pay-1", paymentStatus: "SUCCEEDED" }] },
    ]);

    await expireStaleRequests();

    expect(refundKeys()).toEqual(["pending-subscription:pay-1"]);
  });

  it("keys the consultant no-show refund under its own arm", async () => {
    db.consultation.findMany.mockResolvedValue([noShowCandidate("pay-1")]);
    db.appointmentOccurrence.updateManyAndReturn.mockResolvedValue([
      { id: "occ-1", appointmentId: "apt-1" },
    ]);

    const result = await detectConsultantNoShows();

    expect(result.refunded).toBe(1);
    expect(refundBookingPayment.mock.calls[0][0]).toMatchObject({
      paymentId: "pay-1",
      dedupeKey: "consultant-no-show:pay-1",
    });
  });

  // The whole point of naming the arm: one payment, four reasons, four keys.
  // A shared key would let the second arm read the first arm's refund as its
  // own completed work and report "issued" while moving no money.
  it("gives four arms refunding the same payment four distinct keys", async () => {
    db.consultation.findMany.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) => {
        if (where.status === AppointmentStatus.PENDING) {
          return [pendingConsultationRow("cons-p")];
        }
        // The no-show cohort reads APPROVED/SCHEDULED as an `in` list.
        if (where.status === AppointmentStatus.APPROVED_PENDING_PAYMENT) {
          return [];
        }
        return [noShowCandidate("pay-1")];
      },
    );
    db.subscription.findMany.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) => {
        if (isThirtyDayPendingCohort(where)) return [paidPlanRow("sub-p")];
        if (where.status === AppointmentStatus.APPROVED) {
          return [{ id: "sub-a" }];
        }
        return [];
      },
    );
    // One appointment read per expiring arm, in the order the arms run.
    const wrapper = (id: string) => [
      { id, payment: [{ id: "pay-1", paymentStatus: "SUCCEEDED" }] },
    ];
    db.appointment.findMany
      .mockResolvedValueOnce(wrapper("apt-c"))
      .mockResolvedValueOnce(wrapper("apt-p"))
      .mockResolvedValueOnce(wrapper("apt-a"));
    db.appointmentOccurrence.updateManyAndReturn.mockResolvedValue([
      { id: "occ-1", appointmentId: "apt-1" },
    ]);

    await expireStaleRequests();
    await detectConsultantNoShows();

    expect([...refundKeys()].sort()).toEqual([
      "approved-unallocated:pay-1",
      "consultant-no-show:pay-1",
      "pending-consultation:pay-1",
      "pending-subscription:pay-1",
    ]);
  });

  it("derives the key from nothing that varies per run", async () => {
    db.consultation.findMany.mockResolvedValue([noShowCandidate("pay-1")]);
    db.appointmentOccurrence.updateManyAndReturn.mockResolvedValue([
      { id: "occ-1", appointmentId: "apt-1" },
    ]);

    await detectConsultantNoShows();
    await detectConsultantNoShows();

    // A lost `cron:lock:` grant produces two runs of the same arm on the same
    // row. Identical strings are the whole point: the unique index only
    // dedupes if the second run asks for the same key.
    expect(refundKeys()).toEqual([
      "consultant-no-show:pay-1",
      "consultant-no-show:pay-1",
    ]);
  });
});

// ---------------------------------------------------------------------------
// P0-3 — a reschedule-stranded booking is not auto-refunded
// ---------------------------------------------------------------------------

describe("P0-3 — the 48 h arm refuses a booking parked by a reschedule", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    refundBookingPayment.mockResolvedValue({
      amountRefundedPaise: 150000,
      rail: "GATEWAY",
    });
    db.consultation.findMany.mockResolvedValue([]);
    db.subscription.findMany.mockResolvedValue([]);
    db.appointment.findMany.mockResolvedValue([]);
    db.payment.findMany.mockResolvedValue([]);
    db.refund.findMany.mockResolvedValue([]);
    db.bookingStatusHistory.findMany.mockResolvedValue([]);
    db.notificationOutbox.findMany.mockResolvedValue([]);
    db.failedEmail.findMany.mockResolvedValue([]);
    db.subscription.updateMany.mockResolvedValue({ count: 1 });
  });

  it("excludes a live RESCHEDULED occurrence from the cohort read", async () => {
    await expireStaleRequests();

    const cohort = db.subscription.findMany.mock.calls
      .map(([args]) => args.where as Record<string, unknown>)
      .find(isPaidUnallocatedCohort);
    expect(cohort).toBeDefined();
    expect(cohort.AND).toEqual(expect.arrayContaining([RELEASED_SLOT]));
  });

  // The window this closes: the cohort read and the write are two statements.
  // A booking whose slot was released in between still matches the cohort but
  // must not be expired — the re-stated predicate in the CAS WHERE is what
  // turns that into zero rows and a skip rather than a refund.
  it("re-states the exclusion in the CAS WHERE, so a release between read and write skips the row", async () => {
    db.subscription.findMany.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) =>
        isPaidUnallocatedCohort(where) ? [paidPlanRow("sub-stranded")] : [],
    );
    // The release landed after the cohort read: the CAS matches nothing.
    db.subscription.updateMany.mockResolvedValue({ count: 0 });
    db.payment.findMany.mockResolvedValue([{ id: "pay-1" }]);

    const result = await expireStaleRequests();

    const cas = db.subscription.updateMany.mock.calls
      .map(([args]) => args.where as Record<string, unknown>)
      .find((where) => where.id === "sub-stranded");
    expect(cas).toBeDefined();
    expect(cas.AND).toEqual(expect.arrayContaining([RELEASED_SLOT]));
    // The lost race moves no money and reports nothing expired.
    expect(refundBookingPayment).not.toHaveBeenCalled();
    expect(result.refundsIssued).toBe(0);
    expect(result.subscriptionsExpired).toBe(0);
  });

  it("still expires and refunds an ordinary unallocated paid plan", async () => {
    db.subscription.findMany.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) =>
        isPaidUnallocatedCohort(where) ? [paidPlanRow("sub-plain")] : [],
    );
    db.payment.findMany.mockResolvedValue([{ id: "pay-1" }]);

    const result = await expireStaleRequests();

    expect(result.subscriptionsExpired).toBe(1);
    // The 48 h arm's own pre-existing key is untouched by this change.
    expect(refundKeys()).toEqual(["sub-unalloc:pay-1"]);
  });

  it("leaves the paid money predicate and the live-session guard in place", async () => {
    await expireStaleRequests();

    const cohort = db.subscription.findMany.mock.calls
      .map(([args]) => args.where as Record<string, unknown>)
      .find(isPaidUnallocatedCohort)!;
    const serialised = JSON.stringify(cohort);
    expect(serialised).toContain(PaymentStatus.SUCCEEDED);
    // Zero live CONFIRMED sessions is still required — a half-allocated plan
    // is not this arm's either.
    expect(serialised).toContain("isTentative");
  });
});
