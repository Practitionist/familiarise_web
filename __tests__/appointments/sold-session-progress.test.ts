/**
 * @jest-environment node
 */

/**
 * "k of n sessions" reads the same on every surface: n is the sessions sold
 * (a plan's sold total less the sessions support refunded; a class plan's
 * total), k the sessions delivered as the entitlement counts them. The list
 * rows, the detail page, its header line and the expert's Home all agree.
 */

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { calculateSessionProgress } from "@/app/dashboard/consultant/[consultantId]/utils/appointmentHelpers";
import { mapConsultantAppointments } from "@/lib/appointments/map-consultant";
import { mapConsulteeEvents } from "@/lib/appointments/map-consultee";
import { mapAppointmentDetail } from "@/lib/appointments/map-detail";
import { toPresentationInput } from "@/lib/appointments/presentation-input";
import { deriveBookingPresentation } from "@/lib/dashboard/money-state";
import type { TAppointmentDetail } from "@/lib/data/appointment-detail";
import type { TAppointment } from "@/types/appointment";
import type { TConsulteeEventsResponse } from "@/types/consultee-events";

const NOW = new Date("2026-11-19T06:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const PLAN_START = new Date(NOW.getTime() - 8 * DAY);

const expert = {
  id: "cp-1",
  userId: "u-e",
  user: { name: "Hannah", image: null },
};
const learner = { id: "ce-1", user: { name: "Priya", image: null } };

function session(id: string, daysFromNow: number, completionStatus: string) {
  const startsAt = new Date(NOW.getTime() + daysFromNow * DAY);
  return {
    id,
    appointmentId: "appt-1",
    ordinal: 1,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
    isTentative: false,
    completionStatus,
    outcome: null,
    deletedAt: null,
    meeting: null,
  };
}

/** Week 1 of a 12-session plan, delivered: three confirmed and one parked for review. */
const WEEK_ONE = [
  session("d1", -7, "COMPLETED"),
  session("d2", -6, "COMPLETED"),
  session("d3", -5, "UNVERIFIED"),
  session("d4", -4, "COMPLETED"),
];

const subscription = (sessionsRefunded = 0) => ({
  id: "s-1",
  status: "APPROVED",
  bookingSource: "DIRECT_CHECKOUT",
  pendingPaymentUrl: null,
  requestedAt: PLAN_START,
  createdAt: PLAN_START,
  sessionsTotal: 12,
  sessionsPerWeek: 4,
  sessionsRefunded,
  schedulingPeriodStartsAt: PLAN_START,
  schedulingTimezone: "UTC",
  planEndsAt: null,
  subscriptionPlan: {
    id: "plan-s",
    title: "Weekly coaching",
    price: 1_200_000,
    priceCurrency: "INR",
    // The plan was edited after the sale: the sold total stays 12.
    totalSessions: 16,
    sessionsPerWeek: 4,
    durationInMonths: 3,
    consultantProfile: expert,
  },
  requestedBy: learner,
});

const classRow = {
  id: "cl-1",
  status: "SCHEDULED",
  classPlan: {
    id: "plan-c",
    title: "System design cohort",
    price: 600_000,
    priceCurrency: "INR",
    totalSessions: 12,
    consultantProfileId: "cp-1",
    consultantProfile: expert,
    collaborators: [],
  },
};
/** Three of the class's twelve sessions are on the calendar, one delivered. */
const CLASS_SESSIONS = [
  session("c1", -2, "COMPLETED"),
  session("c2", 5, "SCHEDULED"),
  session("c3", 12, "SCHEDULED"),
];

const wrapper = (over: Record<string, unknown>) => ({
  id: "appt-1",
  organizationId: null,
  organization: null,
  consultation: null,
  subscription: null,
  webinar: null,
  class: null,
  trial: null,
  payment: [],
  participants: [],
  rescheduleRequests: [],
  statusHistory: [],
  ...over,
});

const planDetail = (
  occurrences: ReturnType<typeof session>[],
  sessionsRefunded = 0,
) =>
  ({
    appointment: wrapper({
      appointmentType: "SUBSCRIPTION",
      subscriptionId: "s-1",
      subscription: subscription(sessionsRefunded),
      occurrences,
    }),
  }) as unknown as TAppointmentDetail;

const classDetail = {
  appointment: wrapper({
    appointmentType: "CLASS",
    classId: "cl-1",
    class: classRow,
    occurrences: CLASS_SESSIONS,
  }),
} as unknown as TAppointmentDetail;

const headerLine = (detail: TAppointmentDetail) =>
  deriveBookingPresentation(
    toPresentationInput(detail, {
      viewerId: null,
      names: { payer: "Priya", consultant: "Hannah" },
      sponsorOrgName: null,
    }),
    "CONSULTEE",
    { viewerZone: "UTC", now: NOW },
  ).sessionProgress;

describe("a 12-session plan with week 1 delivered", () => {
  it("reads 4/12 on the learner's list row", () => {
    const [vm] = mapConsulteeEvents(
      {
        consultations: [],
        subscriptions: [
          {
            ...subscription(),
            appointment: wrapper({ occurrences: WEEK_ONE }),
          },
        ],
        webinars: [],
        classes: [],
        trials: [],
      } as unknown as TConsulteeEventsResponse,
      NOW,
    );
    expect(vm.group).toEqual({ total: 12, completed: 4 });
  });

  it("reads 4/12 on the expert's list row and on their Home", () => {
    const appointment = wrapper({
      appointmentType: "SUBSCRIPTION",
      subscriptionId: "s-1",
      subscription: subscription(),
      occurrences: WEEK_ONE,
    }) as unknown as TAppointment;
    const [vm] = mapConsultantAppointments(
      { appointments: [appointment], consultantId: "cp-1" },
      NOW,
    );
    expect(vm.group).toEqual({ total: 12, completed: 4 });
    expect(calculateSessionProgress([appointment])).toMatchObject({
      totalSessions: 12,
      completedSessions: 4,
      remainingSessions: 8,
    });
  });

  it("reads 4 of 12 on the detail page and in its header line", () => {
    const detail = planDetail(WEEK_ONE);
    expect(mapAppointmentDetail(detail, "consultee", NOW).vm.group).toEqual({
      total: 12,
      completed: 4,
    });
    expect(headerLine(detail)).toBe("4 of 12 sessions scheduled · 4 completed");
  });

  it("with one session voided and two refunded by support, the detail reads 4 of 10", () => {
    const detail = planDetail([...WEEK_ONE, session("v1", -1, "VOIDED")], 2);
    expect(mapAppointmentDetail(detail, "consultee", NOW).vm.group).toEqual({
      total: 10,
      completed: 4,
    });
    expect(headerLine(detail)).toBe("4 of 10 sessions scheduled · 4 completed");
  });

  it("a session held for payment or released for a move is not counted as scheduled", () => {
    const detail = planDetail([
      ...WEEK_ONE,
      { ...session("t1", 3, "SCHEDULED"), isTentative: true },
      { ...session("r1", 4, "RESCHEDULED"), isTentative: true },
      session("n1", 5, "SCHEDULED"),
    ]);
    expect(headerLine(detail)).toBe("5 of 12 sessions scheduled · 4 completed");
  });
});

describe("a class with 3 of its 12 sessions placed", () => {
  it("reads 1/12 on the learner's list row, never 1/3", () => {
    const [vm] = mapConsulteeEvents(
      {
        consultations: [],
        subscriptions: [],
        webinars: [],
        classes: [
          {
            ...classRow,
            appointment: wrapper({ occurrences: CLASS_SESSIONS }),
          },
        ],
        trials: [],
      } as unknown as TConsulteeEventsResponse,
      NOW,
    );
    expect(vm.group).toEqual({ total: 12, completed: 1 });
  });

  it("reads 1/12 on the host's list row and on their Home", () => {
    const appointment = wrapper({
      appointmentType: "CLASS",
      classId: "cl-1",
      class: classRow,
      occurrences: CLASS_SESSIONS,
    }) as unknown as TAppointment;
    const [vm] = mapConsultantAppointments(
      { appointments: [appointment], consultantId: "cp-1" },
      NOW,
    );
    expect(vm.group).toEqual({ total: 12, completed: 1 });
    expect(calculateSessionProgress([appointment])).toMatchObject({
      totalSessions: 12,
      completedSessions: 1,
    });
  });

  it("reads 3 of 12 scheduled on the detail page", () => {
    expect(
      mapAppointmentDetail(classDetail, "consultee", NOW).vm.group,
    ).toEqual({ total: 12, completed: 1 });
    expect(headerLine(classDetail)).toBe(
      "3 of 12 sessions scheduled · 1 completed",
    );
  });
});
