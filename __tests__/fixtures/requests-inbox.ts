/**
 * The Requests inbox fixture: one PENDING consultation, one
 * APPROVED_PENDING_PAYMENT consultation, one next-cycle subscription and one
 * AWAITING_PAYMENT trial, plus a where-aware prisma mock that serves them.
 * Shared by the read pin (.test.ts) and the render pin (.test.tsx).
 */

export const NOW = new Date("2026-09-20T12:00:00Z");
export const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
export const hoursAhead = (h: number) =>
  new Date(NOW.getTime() + h * 3_600_000);
export const CP = "cp-1";

const profile = (id: string, name: string) => ({
  id,
  user: { id: `u-${id}`, name, image: null, email: `${id}@example.test` },
});
const consultant = profile("cp-1", "Asha Rao");

/** One wrapper shape for every row; the factory varies only what a case needs. */
function wrapper(
  id: string,
  opts: {
    occurrences?: {
      startsAt: Date;
      isTentative: boolean;
      completionStatus: string;
    }[];
    payment?: { status: string; amount: number; expiresAt: Date | null }[];
  } = {},
) {
  return {
    id,
    organizationId: null,
    organization: null,
    occurrences: (opts.occurrences ?? []).map((o, i) => ({
      id: `${id}-o${i}`,
      startsAt: o.startsAt,
      endsAt: new Date(o.startsAt.getTime() + 3_600_000),
      isTentative: o.isTentative,
      completionStatus: o.completionStatus,
      deletedAt: null,
    })),
    payment: (opts.payment ?? []).map((p, i) => ({
      id: `${id}-p${i}`,
      amount: p.amount,
      originalAmount: p.amount,
      taxAmount: 0,
      currency: "INR",
      paymentStatus: p.status,
      paymentMethod: "CARD",
      paymentGateway: "RAZORPAY",
      receiptUrl: null,
      expiresAt: p.expiresAt,
      createdAt: hoursAgo(2),
      consumerInvoice: null,
      legs: [],
      refunds: [],
      disputes: [],
    })),
    rescheduleRequests: [],
    statusHistory: [],
  };
}

export const pendingConsultation = {
  id: "c-pending",
  status: "PENDING",
  pendingPaymentUrl: null,
  requestedAt: hoursAgo(30),
  bookingSource: "REQUEST_SUBMITTED",
  requestNotes: "Career switch",
  consultationPlan: {
    id: "plan-c",
    title: "Career chat",
    durationInHours: 1,
    price: 150000,
    priceCurrency: "INR",
    consultantProfile: consultant,
  },
  requestedBy: profile("ce-1", "Priya Nair"),
  appointment: wrapper("a-c", {
    occurrences: [
      {
        startsAt: hoursAhead(48),
        isTentative: true,
        completionStatus: "SCHEDULED",
      },
      {
        startsAt: hoursAhead(48.5),
        isTentative: true,
        completionStatus: "SCHEDULED",
      },
    ],
  }),
};

const subscriptionPlan = {
  id: "plan-s",
  title: "Weekly coaching",
  sessionsPerWeek: 2,
  durationInMonths: 3,
  sessionDurationInHours: 1,
  totalSessions: 24,
  price: 2400000,
  priceCurrency: "INR",
  consultantProfile: consultant,
};

const subscriptionBase = {
  bookingSource: "DIRECT_CHECKOUT",
  requestNotes: null,
  schedulingPeriodStartsAt: hoursAgo(24 * 30),
  schedulingPeriodEndsAt: hoursAhead(24 * 60),
  schedulingTimezone: "Asia/Kolkata",
  sessionsTotal: 24,
  sessionsRefunded: 0,
  subscriptionPlan,
  requestedBy: profile("ce-2", "Rahul Sen"),
};

export const awaitingConsultation = {
  id: "c-awaiting",
  status: "APPROVED_PENDING_PAYMENT",
  pendingPaymentUrl: "https://pay.example.test/consultation",
  requestedAt: hoursAgo(5),
  bookingSource: "REQUEST_SUBMITTED",
  requestNotes: null,
  consultationPlan: { ...pendingConsultation.consultationPlan, price: 2400000 },
  requestedBy: profile("ce-2", "Rahul Sen"),
  appointment: wrapper("a-c2", {
    occurrences: [
      {
        startsAt: hoursAhead(72),
        isTentative: true,
        completionStatus: "SCHEDULED",
      },
    ],
    payment: [{ status: "PENDING", amount: 2400000, expiresAt: hoursAhead(6) }],
  }),
};

const nextCycleSubscription = {
  ...subscriptionBase,
  id: "s-next",
  status: "APPROVED",
  requestedAt: hoursAgo(24 * 20),
  appointment: wrapper("a-s2", {
    occurrences: [
      {
        startsAt: hoursAgo(24 * 10),
        isTentative: false,
        completionStatus: "COMPLETED",
      },
      {
        startsAt: hoursAgo(24 * 9),
        isTentative: false,
        completionStatus: "COMPLETED",
      },
      {
        startsAt: hoursAgo(24 * 3),
        isTentative: false,
        completionStatus: "COMPLETED",
      },
      {
        startsAt: hoursAgo(24 * 2),
        isTentative: false,
        completionStatus: "COMPLETED",
      },
    ],
    payment: [{ status: "SUCCEEDED", amount: 2400000, expiresAt: null }],
  }),
};

/** #1775 C-5 — paid at purchase, nothing placed yet: the 48 h allocate clock. */
export const paidUnallocatedSubscription = {
  ...subscriptionBase,
  id: "s-paid",
  status: "PENDING",
  requestedAt: hoursAgo(2),
  appointment: wrapper("a-s3", {
    payment: [{ status: "SUCCEEDED", amount: 2400000, expiresAt: null }],
  }),
};

const awaitingTrial = {
  id: "t-awaiting",
  status: "AWAITING_PAYMENT",
  notes: null,
  requestedAt: hoursAgo(10),
  paymentDueAt: hoursAhead(20),
  consulteeProfile: profile("ce-3", "Meera Iyer"),
  subscriptionPlan: {
    id: "plan-s",
    title: "Weekly coaching",
    trialDurationMinutes: 30,
    trialPriceInPaise: 50000,
    priceCurrency: "INR",
    consultantProfile: consultant,
  },
  appointment: wrapper("a-t", {
    occurrences: [
      {
        startsAt: hoursAhead(30),
        isTentative: true,
        completionStatus: "SCHEDULED",
      },
    ],
  }),
};

type Where = {
  status?: string | { in?: string[] };
  bookingSource?: unknown;
  appointment?: {
    payment?: {
      some?: { paymentStatus?: string };
      none?: { paymentStatus?: string };
    };
  };
  AND?: Where[];
  OR?: Where[];
};
type Row = {
  status: string;
  bookingSource?: string | null;
  appointment?: { payment?: { paymentStatus: string }[] } | null;
};
const statusMatches = (row: Row, where: Where): boolean => {
  const none = where.appointment?.payment?.none?.paymentStatus;
  if (
    none &&
    (row.appointment?.payment ?? []).some((p) => p.paymentStatus === none)
  ) {
    return false;
  }
  const s = where.status;
  if (typeof s === "string" && row.status !== s) return false;
  if (s && typeof s === "object" && !(s.in ?? []).includes(row.status)) {
    return false;
  }
  if (
    typeof where.bookingSource === "string" &&
    row.bookingSource !== where.bookingSource
  ) {
    return false;
  }
  if (!(where.AND ?? []).every((part) => statusMatches(row, part))) {
    return false;
  }
  // OR arms the fake understands: a bookingSource exclusion or a payment
  // status on the wrapper; any other arm counts as a match.
  return !where.OR || where.OR.some((part) => orArmMatches(row, part));
};
const orArmMatches = (row: Row, arm: Where): boolean => {
  const source = arm.bookingSource;
  if (source && typeof source === "object" && "not" in source) {
    return row.bookingSource !== source.not;
  }
  const some = arm.appointment?.payment?.some?.paymentStatus;
  if (some) {
    return (row.appointment?.payment ?? []).some(
      (p) => p.paymentStatus === some,
    );
  }
  return true;
};

/**
 * A tiny fake DB: every read honours `status` and an exact `bookingSource`,
 * at the top level or inside `AND`, nothing else.
 */
export function serve<T extends Row>(rows: T[]) {
  return {
    findMany: async ({ where }: { where: Where }) =>
      rows.filter((r) => statusMatches(r, where)),
    count: async ({ where }: { where: Where }) =>
      rows.filter((r) => statusMatches(r, where)).length,
  };
}

type MockModel = { findMany: jest.Mock; count: jest.Mock };

/** Point a mocked prisma at the fixture; call it in `beforeEach`. */
export function serveInboxFixture(prisma: {
  consultation: MockModel;
  subscription: MockModel;
  trial: MockModel;
  membership: { findMany: jest.Mock };
}) {
  const c = serve([pendingConsultation, awaitingConsultation]);
  const s = serve([nextCycleSubscription]);
  const t = serve([awaitingTrial]);
  prisma.consultation.findMany.mockImplementation(c.findMany);
  prisma.consultation.count.mockImplementation(c.count);
  prisma.subscription.findMany.mockImplementation(s.findMany);
  prisma.subscription.count.mockImplementation(s.count);
  prisma.trial.findMany.mockImplementation(t.findMany);
  prisma.trial.count.mockImplementation(t.count);
  prisma.membership.findMany.mockResolvedValue([]);
}

/**
 * A paid 1:1 a reschedule put back to PENDING: its one session released, and
 * the proposal open (who asked, and whether they named times, vary by case).
 */
export function movingConsultation(
  initiatorRole: "CONSULTEE" | "CONSULTANT",
  withTimes: boolean,
) {
  const appointment = wrapper("a-m", {
    occurrences: [
      {
        startsAt: hoursAhead(72),
        isTentative: true,
        completionStatus: "RESCHEDULED",
      },
    ],
    payment: [{ status: "SUCCEEDED", amount: 150000, expiresAt: null }],
  });
  return {
    ...pendingConsultation,
    id: "c-moving",
    requestedAt: hoursAgo(1),
    appointment: {
      ...appointment,
      rescheduleRequests: [
        {
          id: "rr-1",
          status: "PENDING_REVIEW",
          reason: null,
          expiresAt: hoursAhead(20),
          initiatorRole,
          preferredTimeOfDay: null,
          preferredDays: null,
          proposedTimes: withTimes
            ? [
                {
                  startsAt: hoursAhead(96),
                  endsAt: hoursAhead(96.5),
                },
              ]
            : [],
        },
      ],
    },
  };
}
