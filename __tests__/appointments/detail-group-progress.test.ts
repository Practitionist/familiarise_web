/**
 * @jest-environment node
 */

/**
 * A subscription's "k of n" on the detail page: n is the sessions sold and k
 * the sessions delivered, the same rule the list's group card applies. A dead
 * row (one a reschedule released, or a cancelled one) is never counted as
 * delivered, and the rows placed so far are never the denominator.
 */

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { mapAppointmentDetail } from "@/lib/appointments/map-detail";
import type { TAppointmentDetail } from "@/lib/data/appointment-detail";

const NOW = new Date("2026-09-14T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function row(id: string, hoursFromNow: number, completionStatus = "SCHEDULED") {
  const startsAt = new Date(NOW.getTime() + hoursFromNow * HOUR);
  return {
    id,
    startsAt,
    endsAt: new Date(startsAt.getTime() + HOUR),
    isTentative: false,
    completionStatus,
    deletedAt: null,
    meeting: null,
  };
}

const detail = {
  appointment: {
    id: "appt-sub",
    appointmentType: "SUBSCRIPTION",
    organizationId: null,
    consultation: null,
    webinar: null,
    class: null,
    trial: null,
    subscription: {
      status: "SCHEDULED",
      pendingPaymentUrl: null,
      sessionsTotal: 12,
      sessionsRefunded: 0,
      subscriptionPlan: {
        title: "Weekly coaching",
        consultantProfile: { id: "cp-1", user: { name: "Coach", image: null } },
      },
      requestedBy: { user: { name: "Buyer", image: null } },
    },
    payment: [],
    participants: [],
    occurrences: [
      row("done-1", -48, "COMPLETED"),
      row("done-2", -24, "COMPLETED"),
      row("released", -12, "RESCHEDULED"), // awaiting a new time: not a held call
      row("gone", 24, "CANCELLED"),
      row("next-1", 48),
      row("next-2", 96),
    ],
  },
} as unknown as TAppointmentDetail;

it("counts delivered sessions of the sessions sold, the same way the list's group card does", () => {
  const { vm } = mapAppointmentDetail(detail, "consultee", NOW);
  expect(vm.group).toEqual({ total: 12, completed: 2 });
});

// #1766 — with the plan and the frozen entitlement present the programme is
// the entitlement, so a fresh request reads "0 of 12" instead of vanishing.
it("reads the entitlement for a fresh subscription: 0 of 12", () => {
  const base = detail.appointment.subscription as NonNullable<
    TAppointmentDetail["appointment"]["subscription"]
  >;
  const fresh = {
    appointment: {
      ...detail.appointment,
      occurrences: [],
      subscription: {
        ...base,
        sessionsTotal: 12,
        sessionsRefunded: 0,
        schedulingPeriodStartsAt: NOW,
        schedulingTimezone: "UTC",
        subscriptionPlan: {
          ...base.subscriptionPlan,
          sessionsPerWeek: 4,
          durationInMonths: 3,
          totalSessions: 16,
        },
      },
    },
  } as unknown as TAppointmentDetail;
  const { vm } = mapAppointmentDetail(fresh, "consultee", NOW);
  expect(vm.group).toEqual({ total: 12, completed: 0 });
});
