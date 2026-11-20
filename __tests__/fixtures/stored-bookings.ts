/**
 * Stored bookings as their rows hold them, for reader-shape tests: project
 * them through a screen's real query with `projectRow` and map the result.
 */

type Row = Record<string, unknown>;

export const NOW = new Date();
export const later = (ms: number) => new Date(NOW.getTime() + ms);
export const user = (id: string, name: string) => ({
  id,
  name,
  image: null,
  email: `${id}@example.test`,
});
export const expert = {
  id: "cp-1",
  userId: "u-e",
  user: user("u-e", "Hannah"),
};
export const learner = {
  id: "cee-1",
  userId: "u-l",
  user: user("u-l", "Charlotte"),
};

export type Pay = "live" | "lapsed" | "paid";
export const payment = (pay: Pay) => ({
  id: "pay-1",
  userId: "u-l",
  paymentStatus: { live: "PENDING", lapsed: "EXPIRED", paid: "SUCCEEDED" }[pay],
  paymentIntent: "order_pay1",
  paymentMethod: "CARD",
  organizationId: null,
  expiresAt: pay === "lapsed" ? later(-60_000) : later(15 * 60_000),
  amount: 50_000,
  currency: "INR",
  createdAt: later(-60_000),
  deletedAt: null,
  refunds: [],
});
export const occurrence = (tentative: boolean) => ({
  id: "occ-1",
  appointmentId: "appt-1",
  ordinal: 1,
  startsAt: later(86_400_000),
  endsAt: later(90_000_000),
  isTentative: tentative,
  completionStatus: "SCHEDULED",
  outcome: null,
  deletedAt: null,
  meeting: null,
});
export const wrapper = (over: Row) => ({
  id: "appt-1",
  organizationId: null,
  consultationId: null,
  subscriptionId: null,
  webinarId: null,
  classId: null,
  deletedAt: null,
  createdAt: later(-60_000),
  rescheduleRequests: [],
  participants: [],
  consultation: null,
  subscription: null,
  webinar: null,
  class: null,
  trial: null,
  ...over,
});
export const plan = {
  id: "plan-1",
  title: "Strategy call",
  price: 50_000,
  priceCurrency: "INR",
  durationInHours: 1,
  consultantProfileId: "cp-1",
  consultantProfile: expert,
};
export const request = (status: string) => ({
  status,
  bookingSource: "DIRECT_CHECKOUT",
  requestedAt: later(-60_000),
  pendingPaymentUrl: null,
  requestNotes: null,
  requestedById: "cee-1",
  requestedBy: learner,
});

/** A 1:1 booked through checkout, as the stored rows hold it. */
export function storedConsultation(status: string, pay: Pay, moving = false) {
  const consultation = {
    id: "c-1",
    ...request(status),
    consultationPlanId: "plan-1",
    consultationPlan: plan,
  };
  const appointment = wrapper({
    appointmentType: "CONSULTATION",
    consultationId: "c-1",
    occurrences: [occurrence(pay !== "paid")],
    payment: [payment(pay)],
    rescheduleRequests: moving
      ? [
          {
            id: "rr-1",
            status: "PENDING_REVIEW",
            reason: null,
            round: 1,
            expiresAt: later(86_400_000),
            initiatorRole: "CONSULTANT",
            initiatedById: "u-e",
            createdAt: later(-60_000),
            proposedTimes: [],
          },
        ]
      : [],
  });
  return { consultation, appointment };
}

/** A plan paid at checkout whose first sessions are not placed yet. */
export function storedPaidPlanAwaitingTimes() {
  const subscription = {
    id: "s-1",
    ...request("PENDING"),
    deletedAt: null,
    subscriptionPlanId: "plan-1",
    subscriptionPlan: { ...plan, totalSessions: 4, sessionsPerWeek: 1 },
  };
  const appointment = wrapper({
    appointmentType: "SUBSCRIPTION",
    subscriptionId: "s-1",
    occurrences: [],
    payment: [payment("paid")],
  });
  return { subscription, appointment };
}

/** A webinar seat the learner holds, paid or not. */
export function storedSeat(pay: Pay) {
  return {
    id: "w-1",
    status: "SCHEDULED",
    createdAt: later(-60_000),
    webinarPlan: { ...plan, collaborators: [] },
    appointment: wrapper({
      appointmentType: "WEBINAR",
      webinarId: "w-1",
      occurrences: [occurrence(false)],
      payment: [payment(pay)],
      participants: [
        {
          userId: "u-l",
          role: "CONSULTEE",
          status: pay === "paid" ? "CONFIRMED" : "HELD",
          updatedAt: later(-60_000),
        },
      ],
    }),
  };
}

/** A paid trial holding its time, its pay window open or closed. */
export function storedTrial(open: boolean) {
  return {
    id: "t-1",
    status: "AWAITING_PAYMENT",
    notes: null,
    requestedAt: later(-60_000),
    completedAt: null,
    pendingPaymentUrl: null,
    paymentDueAt: open ? later(15 * 60_000) : later(-60_000),
    consultantProfileId: "cp-1",
    consulteeProfileId: "cee-1",
    subscriptionPlan: {
      id: "plan-1",
      title: "Mentorship",
      trialDurationMinutes: 30,
      trialPriceInPaise: 10_000,
      consultantProfile: expert,
    },
    consulteeProfile: learner,
    appointment: wrapper({
      appointmentType: "TRIAL",
      occurrences: [occurrence(true)],
      payment: [{ ...payment(open ? "live" : "lapsed") }],
    }),
  };
}

/**
 * A paid request-mode 1:1 whose whole-booking move lapsed unanswered and is not
 * settled yet: the parent still PENDING, its session still released.
 */
export function storedLapsedMove() {
  const consultation = {
    id: "c-1",
    ...request("PENDING"),
    bookingSource: "REQUEST_SUBMITTED",
    consultationPlanId: "plan-1",
    consultationPlan: plan,
  };
  const appointment = wrapper({
    appointmentType: "CONSULTATION",
    consultationId: "c-1",
    occurrences: [
      { ...occurrence(true), completionStatus: "RESCHEDULED", movedAt: null },
    ],
    payment: [payment("paid")],
    rescheduleRequests: [
      {
        id: "rr-1",
        status: "PENDING_REVIEW",
        reason: null,
        round: 1,
        expiresAt: later(-60_000),
        originStatus: "APPROVED",
        initiatorRole: "CONSULTEE",
        initiatedById: "u-l",
        createdAt: later(-3_600_000),
        preferredTimeOfDay: null,
        preferredDays: [],
        proposedTimes: [
          {
            startsAt: later(2 * 86_400_000),
            endsAt: later(2 * 86_400_000 + 3_600_000),
          },
        ],
      },
    ],
  });
  return { consultation, appointment };
}
