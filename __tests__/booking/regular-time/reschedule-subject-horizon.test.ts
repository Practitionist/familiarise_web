/**
 * The reschedule picker cuts its window from the same horizon the server
 * uses: a plan with a live Regular time opens four plan weeks, so the client
 * window is never a narrower Phase 0 subset.
 */
import type { TAppointmentDetail } from "@/lib/data/appointment-detail";
import { rescheduleWindow } from "@/lib/booking/entitlement";
import { buildRescheduleSubject } from "@/lib/scheduling/time-picker-subject";

const DAY = 86_400_000;
// Yesterday 00:00 UTC, so plan weeks start at midnight.
const START = new Date(Math.floor(Date.now() / DAY) * DAY - DAY);
const occ = (id: string, day: number) => {
  const startsAt = new Date(START.getTime() + day * DAY + 10 * 3_600_000);
  return {
    id,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 3_600_000),
    isTentative: false,
    completionStatus: "SCHEDULED",
    deletedAt: null,
    appointmentId: "appt-1",
    user: [],
    meeting: null,
  };
};

function detail(regularTimes: { id: string }[]): TAppointmentDetail {
  return {
    appointment: {
      id: "appt-1",
      appointmentType: "SUBSCRIPTION",
      // Weeks 0 and 1 are full (1 a week); week 2 is open.
      occurrences: [occ("a", 2), occ("b", 9)],
      consultation: null,
      subscription: {
        id: "sub-1",
        sessionsTotal: 26,
        sessionsPerWeek: 1,
        sessionMinutes: 60,
        sessionsRefunded: 0,
        schedulingPeriodStartsAt: START,
        schedulingTimezone: "UTC",
        planEndsAt: new Date(START.getTime() + 26 * 7 * DAY),
        regularTimes,
        requestedBy: {
          id: "c-1",
          userId: "u-c",
          user: { id: "u-c", name: "Buyer", image: null },
        },
        subscriptionPlan: {
          title: "Weekly",
          totalSessions: 26,
          sessionsPerWeek: 1,
          durationInMonths: 6,
          sessionDurationInHours: 1,
          consultantProfile: {
            id: "cp-1",
            userId: "u-e",
            user: { id: "u-e", name: "Expert", image: null },
          },
        },
      },
      webinar: null,
      class: null,
      trial: null,
    },
    siblings: [],
  } as unknown as TAppointmentDetail;
}

it("a Regular-time plan's reschedule window reaches the open horizon week, as the server's does", () => {
  const rt = buildRescheduleSubject(detail([{ id: "rt-1" }]))!.subject;
  expect(rt.rescheduleEntitlement?.hasRegularTime).toBe(true);
  const rtWindow = rescheduleWindow(rt.rescheduleEntitlement!, []);
  // Weeks 0 and 1 are full: the first open week is week 2.
  expect(rtWindow.start.getTime()).toBe(START.getTime() + 14 * DAY);

  const phase0 = buildRescheduleSubject(detail([]))!.subject;
  expect(phase0.rescheduleEntitlement?.hasRegularTime).toBe(false);
  const phase0Window = rescheduleWindow(phase0.rescheduleEntitlement!, []);
  // Phase 0 never opens past next week: the window is empty at week 1's end.
  expect(phase0Window.end.getTime()).toBeLessThanOrEqual(
    START.getTime() + 14 * DAY,
  );
});
