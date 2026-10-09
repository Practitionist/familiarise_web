/**
 * @jest-environment node
 */

import {
  attendeeEntitlementFilter,
  webinarRecordingScope,
  webinarRecordingVisible,
} from "../../lib/stream/recording-attendee-scope";

const webinarAppointment = (share: boolean) => ({
  id: "appt-run-1",
  webinar: {
    webinarPlan: { id: "wp-1", shareRecordingsWithAllAttendees: share },
  },
});

describe("recording attendee scope", () => {
  it("limits a webinar attendee to their own run unless the plan shares", () => {
    expect(attendeeEntitlementFilter(webinarAppointment(false))).toEqual({
      id: "appt-run-1",
    });
    expect(attendeeEntitlementFilter(webinarAppointment(true))).toEqual({
      webinar: { webinarPlanId: "wp-1" },
    });
  });

  it("keeps class at plan level and 1:1 per appointment", () => {
    expect(
      attendeeEntitlementFilter({
        id: "appt-c",
        class: { classPlan: { id: "cp-1" } },
      }),
    ).toEqual({ class: { classPlanId: "cp-1" } });
    expect(attendeeEntitlementFilter({ id: "appt-1on1" })).toEqual({
      id: "appt-1on1",
    });
  });

  it("shows own-run recordings always and other runs only when shared", () => {
    const unshared = webinarRecordingScope([
      {
        appointmentId: "run-1",
        webinarPlanId: "wp-1",
        shareRecordingsWithAllAttendees: false,
      },
    ]);
    expect(
      webinarRecordingVisible(
        { appointmentId: "run-1", webinarPlanId: "wp-1" },
        unshared,
      ),
    ).toBe(true);
    expect(
      webinarRecordingVisible(
        { appointmentId: "run-2", webinarPlanId: "wp-1" },
        unshared,
      ),
    ).toBe(false);

    const shared = webinarRecordingScope([
      {
        appointmentId: "run-1",
        webinarPlanId: "wp-1",
        shareRecordingsWithAllAttendees: true,
      },
    ]);
    expect(
      webinarRecordingVisible(
        { appointmentId: "run-2", webinarPlanId: "wp-1" },
        shared,
      ),
    ).toBe(true);
    expect(
      webinarRecordingVisible(
        { appointmentId: "run-9", webinarPlanId: "wp-2" },
        shared,
      ),
    ).toBe(false);
  });
});
