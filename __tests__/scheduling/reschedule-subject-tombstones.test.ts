/**
 * The release list counts only sessions a reschedule can act on: a future
 * tombstoned occurrence is gone and must not inflate the sessions being moved.
 */

import type { TAppointmentDetail } from "@/lib/data/appointment-detail";
import { buildRescheduleSubject } from "@/lib/scheduling/time-picker-subject";

const HOUR = 60 * 60 * 1000;
const inDays = (days: number) => new Date(Date.now() + days * 24 * HOUR);

function occurrence(
  id: string,
  startsAt: Date,
  extra: Partial<{ deletedAt: Date | null; completionStatus: string }> = {},
) {
  return {
    id,
    appointmentId: "appt-sub-1",
    startsAt,
    endsAt: new Date(startsAt.getTime() + HOUR),
    isTentative: false,
    completionStatus: "SCHEDULED",
    deletedAt: null,
    meeting: null,
    ...extra,
  };
}

function subscriptionDetail(
  occurrences: ReturnType<typeof occurrence>[],
): TAppointmentDetail {
  return {
    appointment: {
      id: "appt-sub-1",
      appointmentType: "SUBSCRIPTION",
      occurrences,
      consultation: null,
      subscription: {
        id: "sub-1",
        requestedBy: {
          id: "consultee-1",
          userId: "user-consultee-1",
          user: { id: "user-consultee-1", name: "Buyer", image: null },
        },
        subscriptionPlan: {
          title: "Weekly coaching",
          sessionDurationInHours: 1,
          consultantProfile: {
            id: "cp-1",
            userId: "user-consultant-1",
            user: { id: "user-consultant-1", name: "Expert", image: null },
          },
        },
      },
      webinar: null,
      class: null,
      trial: null,
    },
  } as unknown as TAppointmentDetail;
}

describe("reschedule subject skips tombstoned occurrences", () => {
  it("does not count a future tombstone among the live sessions", () => {
    const subject = buildRescheduleSubject(
      subscriptionDetail([
        occurrence("live-1", inDays(2)),
        occurrence("gone-1", inDays(3), { deletedAt: new Date() }),
        occurrence("live-2", inDays(9)),
      ]),
    );
    expect(subject).not.toBeNull();
    expect(subject!.subject.slots?.map((s) => s.id)).toEqual([
      "live-1",
      "live-2",
    ]);
  });

  it("still drops past, cancelled and released rows", () => {
    const subject = buildRescheduleSubject(
      subscriptionDetail([
        occurrence("past", inDays(-2)),
        occurrence("cancelled", inDays(2), { completionStatus: "CANCELLED" }),
        occurrence("released", inDays(3), { completionStatus: "RESCHEDULED" }),
        occurrence("live", inDays(4)),
      ]),
    );
    expect(subject!.subject.slots?.map((s) => s.id)).toEqual(["live"]);
  });
});
