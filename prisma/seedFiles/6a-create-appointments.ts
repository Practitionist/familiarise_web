import { faker } from "@faker-js/faker";
import {
  AppointmentsType,
  BookingSource,
  ClassPlan,
  ConsultationPlan,
  Currency,
  DayOfWeek,
  ParticipantStatus,
  PaymentGateway,
  PaymentStatus,
  Platform,
  Prisma,
  AppointmentStatus,
  AvailabilityWindowCustom,
  AvailabilityWindowWeekly,
  SubscriptionPlan,
  WebinarPlan,
} from "@prisma/client";
import prisma from "../../lib/prisma";
import { buildOccurrence } from "../../lib/appointments/occurrences";
import { firstCycleWindow, planEndOf } from "../../lib/booking/entitlement";
import { DIRECT_CHECKOUT_HOLD_MS } from "../../lib/payments/constants";
import { resolveSchedulingTimezone } from "../../lib/scheduling/schedulingTimezone";
import { UserWithProfiles } from "./1a-create-users";
import { buildSeedPaymentLegs } from "./8b-create-payments";
import { config, getTotalAppointments } from "./config";
import {
  HostCalendar,
  atGridTime,
  placeSession,
  releasedSession,
} from "./host-calendar";

// #780 — the extended client reads plan money columns (price,
// trialPriceInPaise) as number; the raw model types still say bigint.
type PlanRead<T extends { price: bigint }> = {
  [K in keyof T]: T[K] extends bigint ? number : T[K];
};

// Appointment volumes - configurable via SEED_MODE environment variable
const NUM_CONSULTATION = config.volumes.appointments.consultation;
const NUM_SUBSCRIPTION = config.volumes.appointments.subscription;
const NUM_WEBINAR = config.volumes.appointments.webinar;
const NUM_APPOINTMENTS = getTotalAppointments();
const BATCH_SIZE = config.batchSize;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Subscriptions are allocated this far ahead of their start, cycle by cycle. */
const SUBSCRIPTION_ALLOCATED_HORIZON_MS = 28 * DAY_MS;

// Distribution helpers - uses configurable volumes
const getAppointmentType = (index: number): AppointmentsType => {
  // Distribution based on configured volumes
  if (index < NUM_CONSULTATION) return AppointmentsType.CONSULTATION;
  if (index < NUM_CONSULTATION + NUM_SUBSCRIPTION)
    return AppointmentsType.SUBSCRIPTION;
  if (index < NUM_CONSULTATION + NUM_SUBSCRIPTION + NUM_WEBINAR)
    return AppointmentsType.WEBINAR;
  return AppointmentsType.CLASS;
};

/** A request in one of these states holds no time: its sessions are released. */
const RELEASED_REQUEST_STATUSES: ReadonlySet<AppointmentStatus> = new Set([
  AppointmentStatus.CANCELLED,
  AppointmentStatus.EXPIRED,
  AppointmentStatus.REJECTED,
]);

const getAppointmentStatus = (
  isPastAppointment: boolean,
): AppointmentStatus => {
  const rand = Math.random();

  if (isPastAppointment) {
    if (rand < 0.75) return AppointmentStatus.APPROVED;
    if (rand < 0.92) return AppointmentStatus.CANCELLED;
    return AppointmentStatus.REJECTED;
  }

  if (rand < 0.25) return AppointmentStatus.PENDING;
  if (rand < 0.7) return AppointmentStatus.APPROVED;
  if (rand < 0.85) return AppointmentStatus.EXPIRED;
  if (rand < 0.9) return AppointmentStatus.REJECTED;
  return AppointmentStatus.CANCELLED;
};

/**
 * How the request reached the consultant. An expiry or a rejection answers a
 * request nobody paid for; a checkout hold is PENDING and DIRECT_CHECKOUT.
 */
const getBookingSource = (status: AppointmentStatus): BookingSource => {
  if (
    status === AppointmentStatus.EXPIRED ||
    status === AppointmentStatus.REJECTED
  ) {
    return BookingSource.REQUEST_SUBMITTED;
  }
  return faker.helpers.arrayElement([
    BookingSource.DIRECT_CHECKOUT,
    BookingSource.REQUEST_SUBMITTED,
  ]);
};

// DRAFT is authored-but-not-live, so it cannot describe an instance that
// already has a booked appointment hanging off it. Drafts are seeded separately
// (6b), with no appointment at all — which is what makes them drafts. A past
// event has run (or was cancelled); a future one is scheduled (or cancelled).
type BookedEventStatus = "SCHEDULED" | "COMPLETED" | "CANCELLED";

const getEventStatus = (isPastAppointment: boolean): BookedEventStatus => {
  if (Math.random() < 0.15) return "CANCELLED";
  return isPastAppointment ? "COMPLETED" : "SCHEDULED";
};

const getAppointmentDate = (
  now: Date,
): { startDate: Date; endDate: Date; isPastAppointment: boolean } => {
  const rand = Math.random();
  let startOffset: number;
  let endOffset: number;
  let isPastAppointment = false;

  if (rand < 0.2) {
    // Past appointments (20%)
    startOffset = faker.number.int({ min: -90, max: -1 });
    endOffset = faker.number.int({ min: startOffset + 1, max: 0 });
    isPastAppointment = true;
  } else if (rand < 0.8) {
    // Near future (60%)
    startOffset = faker.number.int({ min: 1, max: 30 });
    endOffset = faker.number.int({
      min: startOffset + 7,
      max: startOffset + 30,
    });
  } else {
    // Far future (20%)
    startOffset = faker.number.int({ min: 31, max: 90 });
    endOffset = faker.number.int({
      min: startOffset + 7,
      max: startOffset + 60,
    });
  }

  const startDate = new Date(now.getTime() + startOffset * DAY_MS);
  const endDate = new Date(now.getTime() + endOffset * DAY_MS);

  return { startDate, endDate, isPastAppointment };
};

const getNumSlots = (appointmentType: AppointmentsType): number => {
  switch (appointmentType) {
    case AppointmentsType.CONSULTATION:
      return 1;
    case AppointmentsType.SUBSCRIPTION: {
      // Create realistic subscription slots based on plan types
      const planType = faker.helpers.arrayElement([
        "basic",
        "extended",
        "comprehensive",
      ]);
      switch (planType) {
        case "basic":
          return faker.number.int({ min: 4, max: 5 }); // 1 call/week for 1 month
        case "extended":
          return faker.number.int({ min: 48, max: 52 }); // 2 calls/week for 6 months
        case "comprehensive":
          return faker.number.int({ min: 72, max: 78 }); // 3 calls/week for 6 months
        default:
          return faker.number.int({ min: 4, max: 12 });
      }
    }
    case AppointmentsType.WEBINAR:
      return 1;
    case AppointmentsType.CLASS:
      return faker.number.int({ min: 4, max: 8 });
    case AppointmentsType.TRIAL:
      return 1;
  }
};

type SlotData =
  | {
      type: "weekly";
      slot: AvailabilityWindowWeekly;
    }
  | {
      type: "custom";
      slot: AvailabilityWindowCustom;
    };

const DAY_OF_WEEK_BY_UTC_DAY: Record<number, DayOfWeek> = {
  0: DayOfWeek.SUNDAY,
  1: DayOfWeek.MONDAY,
  2: DayOfWeek.TUESDAY,
  3: DayOfWeek.WEDNESDAY,
  4: DayOfWeek.THURSDAY,
  5: DayOfWeek.FRIDAY,
  6: DayOfWeek.SATURDAY,
};

/** A session's length on the 30-minute grid, exactly as checkout sizes it. */
const sessionMs = (durationInHours: number): number =>
  buildOccurrence({
    startsAt: new Date(0),
    durationInHours,
    consultantProfileId: "",
  }).endsAt.getTime();

// --- Helper function to create Meeting data ---
const createMeetingData = (
  isPastAppointment: boolean,
): Prisma.MeetingCreateNestedOneWithoutOccurrenceInput => {
  return {
    create: {
      streamCallId: faker.string.uuid(),
      platform: faker.helpers.arrayElement(Object.values(Platform)),
      passcode: faker.string.alphanumeric(6),
      hostKeys: [faker.string.alphanumeric(8), faker.string.alphanumeric(8)],
      recordings: isPastAppointment
        ? {
            create: Array.from(
              { length: faker.number.int({ min: 0, max: 2 }) }, // 0 to 2 recordings for past meetings
              () => ({
                title: faker.lorem.words(3),
                recordingUrl: faker.internet.url(),
                durationInMinutes: faker.number.int({ min: 30, max: 180 }),
                recordedAt: faker.date.past(),
              }),
            ),
          }
        : undefined,
    },
  };
};

/**
 * One session as checkout writes it (`buildOccurrence`: plan length on the
 * grid, the plan's consultant stamped), released when its booking no longer
 * holds time.
 */
const sessionRow = (args: {
  ordinal: number;
  startsAt: Date;
  durationInHours: number;
  consultantProfileId: string;
  isTentative: boolean;
  releasedAt: Date | null;
  now: Date;
}) => {
  const occurrence = buildOccurrence(args);
  return {
    ...occurrence,
    ...(args.releasedAt ? releasedSession(args.releasedAt) : {}),
    meeting: createMeetingData(occurrence.endsAt < args.now),
  };
};

/** The request's seats: HELD while a hold is pending, released with the request. */
const requestParticipants = (
  consultee: UserWithProfiles,
  status: AppointmentStatus,
  consultantUserId?: string,
): Prisma.AppointmentParticipantCreateNestedManyWithoutAppointmentInput => {
  const released = RELEASED_REQUEST_STATUSES.has(status);
  const consulteeStatus: ParticipantStatus = released
    ? ParticipantStatus.CANCELLED
    : status === AppointmentStatus.PENDING
      ? ParticipantStatus.HELD
      : ParticipantStatus.CONFIRMED;
  return {
    create: [
      { userId: consultee.id, role: "CONSULTEE", status: consulteeStatus },
      ...(consultantUserId
        ? [
            {
              userId: consultantUserId,
              role: "CONSULTANT" as const,
              status: released
                ? ParticipantStatus.CANCELLED
                : ParticipantStatus.CONFIRMED,
            },
          ]
        : []),
    ],
  };
};

/** Group-event seats, released when the event is cancelled. */
const eventParticipants = (
  consultee: UserWithProfiles,
  consultees: UserWithProfiles[],
  status: BookedEventStatus,
  consultantUserId?: string,
): Prisma.AppointmentParticipantCreateNestedManyWithoutAppointmentInput => {
  // Pick 2-4 additional participants to simulate a group event
  const otherConsultees = consultees.filter((c) => c.id !== consultee.id);
  const additionalCount = Math.min(
    faker.number.int({ min: 2, max: 4 }),
    otherConsultees.length,
  );
  const additionalParticipants = faker.helpers
    .shuffle(otherConsultees)
    .slice(0, additionalCount);
  const seat =
    status === "CANCELLED"
      ? ParticipantStatus.CANCELLED
      : ParticipantStatus.CONFIRMED;
  return {
    create: [
      ...(consultantUserId
        ? [
            {
              userId: consultantUserId,
              role: "CONSULTANT" as const,
              status: seat,
            },
          ]
        : []),
      { userId: consultee.id, role: "CONSULTEE", status: seat },
      ...additionalParticipants.map((c) => ({
        userId: c.id,
        role: "CONSULTEE" as const,
        status: seat,
      })),
    ],
  };
};

/**
 * A checkout hold's money side: PENDING, unpaid, expiring when the slot hold
 * does (`DIRECT_CHECKOUT_HOLD_MS`), so the abandoned-payments sweep retires it.
 */
const checkoutHold = (
  consultee: UserWithProfiles,
  plan: { price: number; title: string },
  now: Date,
): Prisma.PaymentCreateNestedManyWithoutAppointmentInput => {
  const paymentIntent = `order_seed_${faker.string.uuid()}`;
  const legs = buildSeedPaymentLegs(plan.price, paymentIntent);
  return {
    create: [
      {
        user: { connect: { id: consultee.id } },
        amount: plan.price,
        originalAmount: plan.price,
        currency: Currency.INR,
        description: `Checkout hold for ${plan.title}`,
        paymentMethod: "CARD",
        paymentIntent,
        clientIdempotencyKey: faker.string.uuid(),
        paymentGateway: PaymentGateway.RAZORPAY,
        paymentStatus: PaymentStatus.PENDING,
        expiresAt: new Date(now.getTime() + DIRECT_CHECKOUT_HOLD_MS),
        ...(legs.length > 0 ? { legs: { create: legs } } : {}),
      },
    ],
  };
};

interface RequestArgs {
  consultee: UserWithProfiles;
  status: AppointmentStatus;
  bookingSource: BookingSource;
  now: Date;
  consultantUserId?: string;
}

/** Sessions of a request: tentative while PENDING, released once it ended. */
const requestSessionState = (status: AppointmentStatus, now: Date) => ({
  isTentative:
    status === AppointmentStatus.PENDING ||
    status === AppointmentStatus.EXPIRED ||
    status === AppointmentStatus.REJECTED,
  releasedAt: RELEASED_REQUEST_STATUSES.has(status) ? now : null,
});

/** The request row's lifecycle stamps: a closed request carries its closing time. */
const requestLifecycle = (args: RequestArgs) => ({
  status: args.status,
  requestedAt: args.now,
  requestNotes: faker.lorem.sentence(),
  bookingSource: args.bookingSource,
  ...(RELEASED_REQUEST_STATUSES.has(args.status)
    ? { cancelledAt: args.now }
    : {}),
});

const holdsCheckout = (args: RequestArgs): boolean =>
  args.status === AppointmentStatus.PENDING &&
  args.bookingSource === BookingSource.DIRECT_CHECKOUT;

const createConsultationAppointment = (
  args: RequestArgs & {
    plan: PlanRead<ConsultationPlan>;
    startsAt: Date;
  },
): Prisma.AppointmentCreateInput => {
  const { plan } = args;
  return {
    appointmentType: AppointmentsType.CONSULTATION,
    // #1319 A9 — participant rows mirror the slot connects below.
    participants: requestParticipants(
      args.consultee,
      args.status,
      args.consultantUserId,
    ),
    occurrences: {
      create: sessionRow({
        ordinal: 1,
        startsAt: args.startsAt,
        durationInHours: plan.durationInHours,
        consultantProfileId: plan.consultantProfileId,
        ...requestSessionState(args.status, args.now),
        now: args.now,
      }),
    },
    ...(holdsCheckout(args)
      ? { payment: checkoutHold(args.consultee, plan, args.now) }
      : {}),
    consultation: {
      create: {
        consultationPlan: { connect: { id: plan.id } },
        requestedBy: { connect: { id: args.consultee.consulteeProfile!.id } },
        ...requestLifecycle(args),
      },
    },
  };
};

const createSubscriptionAppointment = (
  args: RequestArgs & {
    plan: PlanRead<SubscriptionPlan>;
    start: Date;
    schedulingTimezone: string;
    sessionStarts: Date[];
  },
): Prisma.AppointmentCreateInput => {
  const { plan } = args;
  // The window checkout persists (the first cycle) and the fixed plan end.
  const period = firstCycleWindow(plan, args.start, args.schedulingTimezone);
  const sessionState = requestSessionState(args.status, args.now);

  return {
    appointmentType: AppointmentsType.SUBSCRIPTION,
    participants: requestParticipants(
      args.consultee,
      args.status,
      args.consultantUserId,
    ),
    occurrences: {
      create: args.sessionStarts.map((startsAt, index) =>
        sessionRow({
          ordinal: index + 1,
          startsAt,
          durationInHours: plan.sessionDurationInHours,
          consultantProfileId: plan.consultantProfileId,
          ...sessionState,
          now: args.now,
        }),
      ),
    },
    ...(holdsCheckout(args)
      ? { payment: checkoutHold(args.consultee, plan, args.now) }
      : {}),
    subscription: {
      create: {
        subscriptionPlan: { connect: { id: plan.id } },
        requestedBy: { connect: { id: args.consultee.consulteeProfile!.id } },
        ...requestLifecycle(args),
        schedulingPeriodStartsAt: period.start,
        schedulingPeriodEndsAt: period.end,
        planEndsAt: planEndOf(
          period.start,
          plan.durationInMonths,
          args.schedulingTimezone,
        ),
        schedulingTimezone: args.schedulingTimezone,
        // #1766 — the entitlement is snapshotted at purchase.
        sessionsTotal: plan.totalSessions,
      },
    },
  };
};

/**
 * The subscription's allocated sessions: up to `sessionsPerWeek` per rolling
 * week from the start, on the consultant's weekly days (any day when they keep
 * none), inside the plan and the allocation horizon, never on a held time.
 */
const subscriptionSessionStarts = (args: {
  calendar: HostCalendar;
  plan: PlanRead<SubscriptionPlan>;
  start: Date;
  planEndsAt: Date;
  weeklyRows: AvailabilityWindowWeekly[];
  fallbackMinutesUtc: number;
  cap: number;
  occupies: boolean;
}): Date[] => {
  const { plan, start } = args;
  const lengthMs = sessionMs(plan.sessionDurationInHours);
  const horizon = Math.min(
    args.planEndsAt.getTime(),
    start.getTime() + SUBSCRIPTION_ALLOCATED_HORIZON_MS,
  );
  const perWeek = new Map<number, number>();
  const starts: Date[] = [];
  for (
    let day = atGridTime(start, 0);
    day.getTime() < horizon && starts.length < args.cap;
    day = new Date(day.getTime() + DAY_MS)
  ) {
    const week = Math.floor((day.getTime() - start.getTime()) / (7 * DAY_MS));
    if ((perWeek.get(week) ?? 0) >= plan.sessionsPerWeek) continue;
    const rowsToday = args.weeklyRows.filter(
      (row) => row.startDay === DAY_OF_WEEK_BY_UTC_DAY[day.getUTCDay()],
    );
    if (args.weeklyRows.length > 0 && rowsToday.length === 0) continue;
    const minutesUtc =
      rowsToday.length > 0
        ? faker.helpers.arrayElement(rowsToday).startTimeUtc
        : args.fallbackMinutesUtc;
    const startsAt = atGridTime(day, minutesUtc);
    const endsAt = new Date(startsAt.getTime() + lengthMs);
    if (startsAt < start || endsAt.getTime() > args.planEndsAt.getTime()) {
      continue;
    }
    if (
      args.occupies &&
      !args.calendar.claim(plan.consultantProfileId, startsAt, endsAt)
    ) {
      continue;
    }
    starts.push(startsAt);
    perWeek.set(week, (perWeek.get(week) ?? 0) + 1);
  }
  return starts;
};

const createWebinarAppointment = (args: {
  consultee: UserWithProfiles;
  consultees: UserWithProfiles[];
  plan: PlanRead<WebinarPlan>;
  /** The plan's consultant: the host whose time the session takes. */
  hostId: string;
  status: BookedEventStatus;
  startsAt: Date;
  now: Date;
  consultantUserId?: string;
}): Prisma.AppointmentCreateInput => {
  const { plan } = args;
  return {
    appointmentType: AppointmentsType.WEBINAR,
    participants: eventParticipants(
      args.consultee,
      args.consultees,
      args.status,
      args.consultantUserId,
    ),
    occurrences: {
      // #1639 item 3 — the plan's consultant is stamped, which is also what
      // puts a group-event row inside `occurrence_no_confirmed_overlap`.
      create: sessionRow({
        ordinal: 1,
        startsAt: args.startsAt,
        durationInHours: plan.durationInHours,
        consultantProfileId: args.hostId,
        isTentative: false,
        releasedAt: args.status === "CANCELLED" ? args.now : null,
        now: args.now,
      }),
    },
    webinar: {
      create: {
        webinarPlan: { connect: { id: plan.id } },
        status: args.status,
        feedbackSummary:
          args.status === "COMPLETED" ? faker.lorem.paragraph() : null,
      },
    },
  };
};

const createClassAppointment = (args: {
  consultee: UserWithProfiles;
  consultees: UserWithProfiles[];
  plan: PlanRead<ClassPlan>;
  hostId: string;
  status: BookedEventStatus;
  sessionStarts: Date[];
  startDate: Date;
  endDate: Date;
  now: Date;
  consultantUserId?: string;
}): Prisma.AppointmentCreateInput => {
  const { plan } = args;
  return {
    appointmentType: AppointmentsType.CLASS,
    participants: eventParticipants(
      args.consultee,
      args.consultees,
      args.status,
      args.consultantUserId,
    ),
    occurrences: {
      create: args.sessionStarts.map((startsAt, index) =>
        sessionRow({
          ordinal: index + 1,
          startsAt,
          durationInHours: plan.sessionDurationInHours,
          consultantProfileId: args.hostId,
          isTentative: false,
          releasedAt: args.status === "CANCELLED" ? args.now : null,
          now: args.now,
        }),
      ),
    },
    class: {
      create: {
        classPlan: { connect: { id: plan.id } },
        schedulingPeriodStartsAt: args.startDate,
        schedulingPeriodEndsAt: args.endDate,
        schedulingTimezone: "UTC",
        status: args.status,
        feedbackSummary:
          args.status === "COMPLETED" ? faker.lorem.paragraph() : null,
      },
    },
  };
};

/** Class sessions: weekly from the start at a business hour, never on a held time. */
const classSessionStarts = (args: {
  calendar: HostCalendar;
  plan: PlanRead<ClassPlan>;
  hostId: string;
  startDate: Date;
  count: number;
  occupies: boolean;
  step: 1 | -1;
}): Date[] => {
  const lengthMs = sessionMs(args.plan.sessionDurationInHours);
  const businessHours = [9, 10, 11, 14, 15, 16, 17];
  const starts: Date[] = [];
  for (let index = 0; index < args.count; index++) {
    const week = new Date(args.startDate.getTime() + index * 7 * DAY_MS);
    const from = atGridTime(
      week,
      faker.helpers.arrayElement(businessHours) * 60,
    );
    const startsAt = placeSession(args.calendar, args.hostId, from, lengthMs, {
      occupies: args.occupies,
      step: args.step,
      tries: 6,
    });
    if (startsAt) starts.push(startsAt);
  }
  return starts;
};

/** Marks the QA cohort's request rows; nothing else writes this prefix. */
export const QA_COHORT_NOTE = "QA cohort:";

/** A captured payment as checkout leaves it: SUCCEEDED, its CARD leg, no hold clock. */
const capturedPayment = (
  consultee: UserWithProfiles,
  plan: { price: number; title: string },
  now: Date,
): Prisma.PaymentCreateNestedManyWithoutAppointmentInput => {
  const paymentIntent = `order_seed_${faker.string.uuid()}`;
  const legs = buildSeedPaymentLegs(plan.price, paymentIntent);
  return {
    create: [
      {
        user: { connect: { id: consultee.id } },
        amount: plan.price,
        originalAmount: plan.price,
        currency: Currency.INR,
        description: `Payment for ${plan.title}`,
        paymentMethod: "CARD",
        paymentIntent,
        clientIdempotencyKey: faker.string.uuid(),
        paymentGateway: PaymentGateway.RAZORPAY,
        paymentStatus: PaymentStatus.SUCCEEDED,
        capturedAt: now,
        ...(legs.length > 0 ? { legs: { create: legs } } : {}),
      },
    ],
  };
};

/**
 * The two no-session states the dashboards render, seeded on purpose: three
 * paid plans awaiting their first session ("Awaiting scheduling") and one
 * paid consultation whose only session was cancelled ("Needs rescheduling").
 * Both are states the app reaches; `QA_COHORT_NOTE` labels them.
 */
async function createSessionGapCohort(args: {
  consultees: UserWithProfiles[];
  consultationPlans: PlanRead<ConsultationPlan>[];
  subscriptionPlans: PlanRead<SubscriptionPlan>[];
  consultants: Record<string, { userId: string; timezone: string | null }>;
  now: Date;
}): Promise<number> {
  const buyers = args.consultees.filter((c) => c.consulteeProfile).slice(0, 4);
  const subscriptionPlans = args.subscriptionPlans.slice(0, 3);
  const consultationPlan = args.consultationPlans[0];
  if (buyers.length < 4 || subscriptionPlans.length < 3 || !consultationPlan) {
    return 0;
  }
  const start = atGridTime(new Date(args.now.getTime() + DAY_MS), 9 * 60);
  const rows: Prisma.AppointmentCreateInput[] = subscriptionPlans.map(
    (plan, index) => {
      const consultee = buyers[index];
      const consultant = args.consultants[plan.consultantProfileId];
      const timezone = resolveSchedulingTimezone(consultant?.timezone);
      const period = firstCycleWindow(plan, start, timezone);
      return {
        appointmentType: AppointmentsType.SUBSCRIPTION,
        participants: requestParticipants(
          consultee,
          AppointmentStatus.APPROVED,
          consultant?.userId,
        ),
        payment: capturedPayment(consultee, plan, args.now),
        subscription: {
          create: {
            subscriptionPlan: { connect: { id: plan.id } },
            requestedBy: { connect: { id: consultee.consulteeProfile!.id } },
            status: AppointmentStatus.APPROVED,
            requestedAt: args.now,
            requestNotes: `${QA_COHORT_NOTE} awaiting scheduling`,
            bookingSource: BookingSource.DIRECT_CHECKOUT,
            schedulingPeriodStartsAt: period.start,
            schedulingPeriodEndsAt: period.end,
            planEndsAt: planEndOf(
              period.start,
              plan.durationInMonths,
              timezone,
            ),
            schedulingTimezone: timezone,
            sessionsTotal: plan.totalSessions,
          },
        },
      };
    },
  );
  const consultee = buyers[3];
  rows.push({
    appointmentType: AppointmentsType.CONSULTATION,
    participants: requestParticipants(
      consultee,
      AppointmentStatus.APPROVED,
      args.consultants[consultationPlan.consultantProfileId]?.userId,
    ),
    // The host cancelled the one session: released, so it holds no time.
    occurrences: {
      create: sessionRow({
        ordinal: 1,
        startsAt: start,
        durationInHours: consultationPlan.durationInHours,
        consultantProfileId: consultationPlan.consultantProfileId,
        isTentative: false,
        releasedAt: args.now,
        now: args.now,
      }),
    },
    payment: capturedPayment(consultee, consultationPlan, args.now),
    consultation: {
      create: {
        consultationPlan: { connect: { id: consultationPlan.id } },
        requestedBy: { connect: { id: consultee.consulteeProfile!.id } },
        status: AppointmentStatus.APPROVED,
        requestedAt: args.now,
        requestNotes: `${QA_COHORT_NOTE} needs rescheduling`,
        bookingSource: BookingSource.DIRECT_CHECKOUT,
      },
    },
  });

  for (const [index, data] of rows.entries()) {
    const buyer = buyers[index];
    await prisma.$transaction(async (tx) => {
      const created = await tx.appointment.create({
        data: { ...data, chatChannelEnsuredAt: args.now },
        select: { id: true, payment: { select: { id: true } } },
      });
      await tx.appointmentParticipant.updateMany({
        where: { appointmentId: created.id, userId: buyer.id, paymentId: null },
        data: { paymentId: created.payment[0].id },
      });
    });
  }
  return rows.length;
}

async function createAppointmentBatch(
  consultees: UserWithProfiles[],
  allSlots: SlotData[],
  consultationPlans: PlanRead<ConsultationPlan>[],
  subscriptionPlans: PlanRead<SubscriptionPlan>[],
  webinarPlans: PlanRead<WebinarPlan>[],
  classPlans: PlanRead<ClassPlan>[],
  weeklySlots: AvailabilityWindowWeekly[],
  startIndex: number,
  batchSize: number,
  consultants: Record<string, { userId: string; timezone: string | null }>,
  calendar: HostCalendar,
): Promise<number> {
  let successCount = 0;

  for (
    let i = startIndex;
    i < Math.min(startIndex + batchSize, NUM_APPOINTMENTS);
    i++
  ) {
    const consultee = consultees[i % consultees.length];
    const slotData = allSlots[i];

    if (!consultee.consulteeProfile) {
      console.warn(`Skipping consultee ${consultee.id} - no profile found`);
      continue;
    }

    if (!slotData) {
      console.warn(
        `No slot data available for appointment ${i + 1}. This is likely due to insufficient slots created. Skipping appointment creation...`,
      );
      continue;
    }

    try {
      const appointmentType = getAppointmentType(i);
      const now = new Date();
      const { startDate, endDate, isPastAppointment } = getAppointmentDate(now);
      const numSlots = getNumSlots(appointmentType);
      const step = isPastAppointment ? -1 : 1;

      // Extract the consultant ID from the slot to ensure data integrity
      // This ensures appointments use the correct consultant's plans
      const slotConsultantId = slotData.slot.consultantProfileId;
      const consultant = consultants[slotConsultantId];
      const consultantUserId = consultant?.userId;

      // The published time of day this booking was made against.
      const slotMinutesUtc =
        slotData.type === "weekly"
          ? slotData.slot.startTimeUtc
          : slotData.slot.startsAt.getUTCHours() * 60 +
            slotData.slot.startsAt.getUTCMinutes();
      const slotStart = atGridTime(startDate, slotMinutesUtc);

      let appointmentData: Prisma.AppointmentCreateInput | null = null;

      switch (appointmentType) {
        case AppointmentsType.CONSULTATION: {
          const plans = consultationPlans.filter(
            (p) => p.consultantProfileId === slotConsultantId,
          );
          if (plans.length === 0) break;
          // #1639 item 3 — pick once and reuse, so the occurrence's stamp
          // matches the plan actually connected.
          const plan = faker.helpers.arrayElement(plans);
          const status = getAppointmentStatus(isPastAppointment);
          const startsAt = placeSession(
            calendar,
            plan.consultantProfileId,
            slotStart,
            sessionMs(plan.durationInHours),
            { occupies: !RELEASED_REQUEST_STATUSES.has(status), step },
          );
          if (!startsAt) break;
          appointmentData = createConsultationAppointment({
            consultee,
            plan,
            status,
            bookingSource: getBookingSource(status),
            startsAt,
            now,
            consultantUserId,
          });
          break;
        }

        case AppointmentsType.SUBSCRIPTION: {
          const plans = subscriptionPlans.filter(
            (p) => p.consultantProfileId === slotConsultantId,
          );
          if (plans.length === 0) break;
          const plan = faker.helpers.arrayElement(plans);
          const status = getAppointmentStatus(isPastAppointment);
          const schedulingTimezone = resolveSchedulingTimezone(
            consultant?.timezone,
          );
          const sessionStarts = subscriptionSessionStarts({
            calendar,
            plan,
            start: startDate,
            planEndsAt: planEndOf(
              startDate,
              plan.durationInMonths,
              schedulingTimezone,
            ),
            weeklyRows: weeklySlots.filter(
              (s) => s.consultantProfileId === slotConsultantId,
            ),
            fallbackMinutesUtc: slotMinutesUtc,
            cap: Math.min(numSlots, plan.totalSessions),
            occupies: !RELEASED_REQUEST_STATUSES.has(status),
          });
          if (sessionStarts.length === 0) break;
          appointmentData = createSubscriptionAppointment({
            consultee,
            plan,
            status,
            bookingSource: getBookingSource(status),
            start: startDate,
            schedulingTimezone,
            sessionStarts,
            now,
            consultantUserId,
          });
          break;
        }

        case AppointmentsType.WEBINAR: {
          const plans = webinarPlans.filter(
            (p) => p.consultantProfileId === slotConsultantId,
          );
          if (plans.length === 0) break;
          const plan = faker.helpers.arrayElement(plans);
          const status = getEventStatus(isPastAppointment);
          const startsAt = placeSession(
            calendar,
            slotConsultantId,
            slotStart,
            sessionMs(plan.durationInHours),
            { occupies: status !== "CANCELLED", step },
          );
          if (!startsAt) break;
          appointmentData = createWebinarAppointment({
            consultee,
            consultees,
            plan,
            hostId: slotConsultantId,
            status,
            startsAt,
            now,
            consultantUserId,
          });
          break;
        }

        case AppointmentsType.CLASS: {
          const plans = classPlans.filter(
            (p) => p.consultantProfileId === slotConsultantId,
          );
          if (plans.length === 0) break;
          const plan = faker.helpers.arrayElement(plans);
          const status = getEventStatus(isPastAppointment);
          // Limit slots to prevent transaction timeout
          const sessionStarts = classSessionStarts({
            calendar,
            plan,
            hostId: slotConsultantId,
            startDate,
            count: Math.min(numSlots, 4),
            occupies: status !== "CANCELLED",
            step,
          });
          if (sessionStarts.length === 0) break;
          appointmentData = createClassAppointment({
            consultee,
            consultees,
            plan,
            hostId: slotConsultantId,
            status,
            sessionStarts,
            startDate,
            endDate,
            now,
            consultantUserId,
          });
          break;
        }
      }

      // No plan of this type, or no free time for it: nothing to book.
      if (!appointmentData) continue;
      const data = appointmentData;

      // Execute transaction with increased timeout (60 seconds)
      await prisma.$transaction(
        async (tx) => {
          const created = await tx.appointment.create({
            // #1708 — seeded parties share no real booking link, so the chat
            // sweep can never ensure a channel; stamp it as decided.
            data: { ...data, chatChannelEnsuredAt: now },
            select: { id: true, payment: { select: { id: true } } },
          });
          // #1319 A9 — a checkout hold's payment is stamped on the buyer's seat.
          const hold = created.payment[0];
          if (hold) {
            await tx.appointmentParticipant.updateMany({
              where: {
                appointmentId: created.id,
                userId: consultee.id,
                paymentId: null,
              },
              data: { paymentId: hold.id },
            });
          }
        },
        {
          timeout: 60000, // Increased to 60 seconds
        },
      );

      successCount++;
    } catch (error) {
      console.error(
        `Failed to create appointment ${i + 1} for consultee ${consultee.id}. Error details:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return successCount;
}

export async function createAppointments(consultees: UserWithProfiles[]) {
  console.log(
    `Creating ${NUM_APPOINTMENTS} appointments in batches of ${BATCH_SIZE}...`,
  );

  // Fetch all required data upfront
  const weeklySlots = await prisma.availabilityWindowWeekly.findMany({
    take: NUM_APPOINTMENTS / 2,
  });
  const customSlots = await prisma.availabilityWindowCustom.findMany({
    take: NUM_APPOINTMENTS / 2,
  });
  const consultationPlans = await prisma.consultationPlan.findMany();
  const subscriptionPlans = await prisma.subscriptionPlan.findMany();
  const webinarPlans = await prisma.webinarPlan.findMany();
  const classPlans = await prisma.classPlan.findMany();

  // Build a map of consultantProfileId -> consultantUserId so we can connect
  // the consultant user to every AppointmentOccurrence. Without this, the
  // validateNoConflicts query (which filters by user.some.id = consultantUserId)
  // cannot detect conflicts against seed-generated appointments.
  // The consultant's zone is what checkout stamps on a subscription.
  const consultantProfiles = await prisma.consultantProfile.findMany({
    select: { id: true, userId: true, user: { select: { timezone: true } } },
  });
  const consultants: Record<
    string,
    { userId: string; timezone: string | null }
  > = Object.fromEntries(
    consultantProfiles.map((p) => [
      p.id,
      { userId: p.userId, timezone: p.user?.timezone ?? null },
    ]),
  );
  const calendar = new HostCalendar();

  const allSlots: SlotData[] = [
    ...weeklySlots.map((slot) => ({ type: "weekly" as const, slot })),
    ...customSlots.map((slot) => ({ type: "custom" as const, slot })),
  ];

  let totalCreated = 0;

  // Process appointments in batches
  for (
    let batchStart = 0;
    batchStart < NUM_APPOINTMENTS;
    batchStart += BATCH_SIZE
  ) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, NUM_APPOINTMENTS);
    console.log(`Processing appointments ${batchStart + 1} to ${batchEnd}...`);

    const batchCount = await createAppointmentBatch(
      consultees,
      allSlots,
      consultationPlans,
      subscriptionPlans,
      webinarPlans,
      classPlans,
      weeklySlots,
      batchStart,
      BATCH_SIZE,
      consultants,
      calendar,
    );

    totalCreated += batchCount;

    if (batchEnd % 20 === 0 || batchEnd === NUM_APPOINTMENTS) {
      console.log(
        `Created ${totalCreated} appointments successfully (processed ${batchEnd} total)`,
      );
    }

    // Small delay between batches to prevent overwhelming the database
    if (batchEnd < NUM_APPOINTMENTS) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  console.log(
    `Finished creating appointments. Successfully created ${totalCreated} out of ${NUM_APPOINTMENTS} requested.`,
  );

  const cohort = await createSessionGapCohort({
    consultees,
    consultationPlans,
    subscriptionPlans,
    consultants,
    now: new Date(),
  });
  console.log(`Created ${cohort} QA cohort bookings with no live session.`);

  // #1554 — what the auto-complete sweep does on a live database: a confirmed
  // call that has ended is UNVERIFIED, so the review seed (7b) has held calls.
  const held = await prisma.appointmentOccurrence.updateMany({
    where: {
      endsAt: { lt: new Date() },
      isTentative: false,
      completionStatus: "SCHEDULED",
      deletedAt: null,
    },
    data: { completionStatus: "UNVERIFIED" },
  });
  console.log(`Marked ${held.count} past occurrences UNVERIFIED (held).`);
}
