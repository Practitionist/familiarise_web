/**
 * @jest-environment node
 */

// Invariant: an approved booking with no live session is never filed under
// "past" or shown as an ordinary upcoming row: a plan awaiting its first cycle
// says "Awaiting scheduling", a booking whose sessions were all released says
// "Needs rescheduling".

import { deriveBucket, noSessionLabel } from "@/lib/appointments/bucket";
import { mapConsultantAppointments } from "@/lib/appointments/map-consultant";
import type { OccurrenceVM } from "@/lib/appointments/view-model";
import type { TAppointment } from "@/types/appointment";

const NOW = new Date("2026-10-27T12:00:00Z");

const released: OccurrenceVM = {
  occurrenceId: "o-1",
  appointmentId: "a-1",
  startsAt: new Date("2026-10-20T10:00:00Z"),
  endsAt: new Date("2026-10-20T11:00:00Z"),
  isTentative: false,
  completionStatus: "RESCHEDULED",
  meetingEndedAt: null,
  meetingEndedReason: null,
  parked: false,
};

describe("bookings with no live session", () => {
  it("an approved plan with no occurrence yet is awaiting scheduling", () => {
    expect(
      deriveBucket(
        { status: "APPROVED", occurrences: [], kind: "SUBSCRIPTION", now: NOW },
        "consultant",
      ),
    ).toEqual({
      bucket: "needsAction",
      needsActionReason: "AWAITING_SCHEDULING",
    });
  });

  it("an approved consultation whose only session was released needs rescheduling", () => {
    expect(
      deriveBucket(
        {
          status: "APPROVED",
          occurrences: [released],
          kind: "CONSULTATION",
          now: NOW,
        },
        "consultee",
      ),
    ).toEqual({
      bucket: "needsAction",
      needsActionReason: "NEEDS_RESCHEDULING",
    });
    expect(
      deriveBucket(
        { status: "APPROVED", occurrences: [], kind: "CONSULTATION", now: NOW },
        "consultee",
      ).needsActionReason,
    ).toBe("NEEDS_RESCHEDULING");
  });

  it("labels each state in place of a time", () => {
    expect(noSessionLabel("AWAITING_SCHEDULING")).toBe("Awaiting scheduling");
    expect(noSessionLabel("NEEDS_RESCHEDULING")).toBe("Needs rescheduling");
    expect(noSessionLabel(null)).toBe("Not scheduled");
  });

  it("the consultant list maps a slot-less subscription wrapper without crashing", () => {
    const wrapper = {
      id: "a-sub",
      appointmentType: "SUBSCRIPTION",
      organizationId: null,
      occurrences: [],
      subscription: {
        id: "s-1",
        status: "APPROVED",
        subscriptionPlan: {
          id: "plan-s",
          title: "Weekly coaching",
          consultantProfileId: "cp-1",
          consultantProfile: {
            id: "cp-1",
            userId: "u-cp",
            user: { id: "u-cp", name: "Asha", image: null },
          },
        },
        requestedBy: {
          id: "ce-1",
          user: { id: "u-ce", name: "Rahul", email: null, image: null },
        },
        schedulingPeriodStartsAt: NOW,
        schedulingPeriodEndsAt: NOW,
        schedulingTimezone: "Asia/Kolkata",
        sessionsTotal: 8,
      },
    } as unknown as TAppointment;
    const [vm] = mapConsultantAppointments(
      { appointments: [wrapper], consultantId: "cp-1" },
      NOW,
    );
    expect(vm.bucket).toBe("needsAction");
    expect(vm.needsActionReason).toBe("AWAITING_SCHEDULING");
  });
});
