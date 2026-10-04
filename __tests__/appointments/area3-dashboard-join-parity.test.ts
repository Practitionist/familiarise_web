/**
 * @jest-environment node
 */

import {
  upcomingOccurrences,
  REJOIN_GRACE_MS,
} from "@/lib/appointments/occurrences";
import {
  processAllEvents,
  getUpcomingEvents,
} from "@/app/dashboard/consultee/[consulteeId]/(features)/home/event-processor";
import { mapConsulteeEvents } from "@/lib/appointments/map-consultee";
import {
  getAppointmentLifecycleStatus,
  mapConsultantAppointments,
} from "@/lib/appointments/map-consultant";
import {
  getAppointmentTypeAndPlan,
  getConsumeeName,
  getTodayAppointments,
} from "@/app/dashboard/consultant/[consultantId]/utils/appointmentHelpers";
import type { TAppointment } from "@/types/appointment";

describe("Area 3 — Dashboard Appointment Display & Join-Button Timing Parity", () => {
  describe("upcomingOccurrences filters dead occurrences", () => {
    it("drops CANCELLED, RESCHEDULED, and soft-deleted occurrences", () => {
      const now = new Date("2026-08-01T10:00:00.000Z");
      const rows = [
        {
          id: "dead-cancelled",
          startsAt: new Date("2026-08-01T11:00:00.000Z"),
          endsAt: new Date("2026-08-01T12:00:00.000Z"),
          completionStatus: "CANCELLED",
        },
        {
          id: "dead-rescheduled",
          startsAt: new Date("2026-08-01T12:00:00.000Z"),
          endsAt: new Date("2026-08-01T13:00:00.000Z"),
          completionStatus: "RESCHEDULED",
        },
        {
          id: "dead-deleted",
          startsAt: new Date("2026-08-01T13:00:00.000Z"),
          endsAt: new Date("2026-08-01T14:00:00.000Z"),
          completionStatus: "SCHEDULED",
          deletedAt: new Date("2026-08-01T09:00:00.000Z"),
        },
        {
          id: "live-scheduled",
          startsAt: new Date("2026-08-01T14:00:00.000Z"),
          endsAt: new Date("2026-08-01T15:00:00.000Z"),
          completionStatus: "SCHEDULED",
        },
      ];

      expect(upcomingOccurrences(rows, now).map((r) => r.id)).toEqual([
        "live-scheduled",
      ]);
    });
  });

  describe("Consultee Home event-processor", () => {
    const baseNow = new Date("2026-08-01T10:15:00.000Z");

    it("includes Trial sessions in processAllEvents and keeps in-progress sessions in getUpcomingEvents", () => {
      const events = processAllEvents(
        {
          consultations: [],
          subscriptions: [],
          webinars: [],
          classes: [],
          trials: [
            {
              id: "trial-1",
              status: "SCHEDULED",
              subscriptionPlan: {
                title: "Growth Mentorship",
                consultantProfile: {
                  user: { name: "Dr. Ada", image: null },
                },
              },
              appointment: {
                id: "appt-trial-1",
                occurrences: [
                  {
                    id: "occ-trial-1",
                    startsAt: "2026-08-01T10:00:00.000Z",
                    endsAt: "2026-08-01T10:30:00.000Z",
                    isTentative: false,
                    completionStatus: "SCHEDULED",
                    meeting: null,
                  },
                ],
              },
            } as never,
          ],
        },
        baseNow,
      );

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("trial");
      expect(events[0].title).toBe("Growth Mentorship");
      expect(events[0].joinableOccurrence?.id).toBe("occ-trial-1");

      // At 10:15 (15m after start, 15m before end), session is in progress and MUST remain in upcoming
      const upcomingDuring = getUpcomingEvents(events, baseNow);
      expect(upcomingDuring).toHaveLength(1);

      // At 10:45 (15m after end, within 30m REJOIN_GRACE_MS), session still remains in upcoming
      const upcomingGrace = getUpcomingEvents(
        events,
        new Date(
          new Date("2026-08-01T10:30:00.000Z").getTime() +
            REJOIN_GRACE_MS -
            60_000,
        ),
      );
      expect(upcomingGrace).toHaveLength(1);

      // After 30m grace window expires, session leaves upcoming
      const afterGrace = new Date(
        new Date("2026-08-01T10:30:00.000Z").getTime() +
          REJOIN_GRACE_MS +
          60_000,
      );
      const refreshedAfterGrace = processAllEvents(
        {
          consultations: [],
          subscriptions: [],
          webinars: [],
          classes: [],
          trials: [
            {
              id: "trial-1",
              status: "SCHEDULED",
              subscriptionPlan: {
                title: "Growth Mentorship",
                consultantProfile: {
                  user: { name: "Dr. Ada", image: null },
                },
              },
              appointment: {
                id: "appt-trial-1",
                occurrences: [
                  {
                    id: "occ-trial-1",
                    startsAt: "2026-08-01T10:00:00.000Z",
                    endsAt: "2026-08-01T10:30:00.000Z",
                    isTentative: false,
                    completionStatus: "SCHEDULED",
                    meeting: null,
                  },
                ],
              },
            } as never,
          ],
        },
        afterGrace,
      );
      expect(getUpcomingEvents(refreshedAfterGrace, afterGrace)).toHaveLength(
        0,
      );
    });

    it("does not resurrect a RESCHEDULED or CANCELLED future slot when live slots have ended", () => {
      const events = processAllEvents(
        {
          consultations: [
            {
              id: "cons-1",
              status: "SCHEDULED",
              consultationPlan: {
                title: "Architecture Review",
                consultantProfile: { user: { name: "Expert", image: null } },
              },
              appointment: {
                id: "appt-cons-1",
                occurrences: [
                  {
                    id: "occ-dead-future",
                    startsAt: "2026-08-05T10:00:00.000Z",
                    endsAt: "2026-08-05T11:00:00.000Z",
                    isTentative: false,
                    completionStatus: "CANCELLED",
                    meeting: null,
                  },
                ],
              },
            } as never,
          ],
          subscriptions: [],
          webinars: [],
          classes: [],
          trials: [],
        },
        baseNow,
      );

      expect(events).toHaveLength(0);
    });
  });

  describe("mapConsulteeEvents — dead occurrences & trial payment URL", () => {
    it("filters dead occurrences from rawOccurrences and populates pendingPaymentUrl on AWAITING_PAYMENT trials", () => {
      const vms = mapConsulteeEvents(
        {
          consultations: [
            {
              id: "cons-resched",
              status: "SCHEDULED",
              requestedAt: "2026-08-01T00:00:00.000Z",
              consultationPlan: {
                id: "plan-1",
                title: "System Design",
                price: 1000,
                priceCurrency: "INR",
                durationInHours: 1,
                consultantProfile: {
                  id: "cp-1",
                  user: { id: "u-1", name: "Bob", image: null },
                },
              },
              appointment: {
                id: "appt-resched",
                occurrences: [
                  {
                    id: "old-confirmed-rescheduled",
                    startsAt: "2026-08-02T10:00:00.000Z",
                    endsAt: "2026-08-02T11:00:00.000Z",
                    isTentative: false,
                    completionStatus: "RESCHEDULED",
                    meeting: null,
                  },
                  {
                    id: "new-tentative-live",
                    startsAt: "2026-08-03T10:00:00.000Z",
                    endsAt: "2026-08-03T11:00:00.000Z",
                    isTentative: true,
                    completionStatus: "SCHEDULED",
                    meeting: null,
                  },
                ],
                payment: [],
              },
            } as never,
          ],
          subscriptions: [],
          webinars: [],
          classes: [],
          trials: [
            {
              id: "trial-pay",
              status: "AWAITING_PAYMENT",
              requestedAt: "2026-08-01T00:00:00.000Z",
              subscriptionPlan: {
                id: "sub-plan-1",
                title: "Mentorship",
                price: 5000,
                priceCurrency: "INR",
                freeTrial: false,
                trialPrice: 500,
                trialDurationMinutes: 30,
                consultantProfile: {
                  id: "cp-1",
                  user: { id: "u-1", name: "Bob", image: null },
                },
              },
              consultantProfile: {
                id: "cp-1",
                user: { id: "u-1", name: "Bob", image: null },
              },
              appointment: {
                id: "appt-trial-pay",
                occurrences: [],
                payment: [
                  {
                    id: "pay-trial-1",
                    paymentStatus: "PENDING",
                    paymentIntent: "https://pay.example.com/trial-1",
                    expiresAt: new Date("2026-08-02T00:00:00.000Z"),
                  },
                ],
              },
            } as never,
          ],
        },
        new Date("2026-08-01T10:00:00.000Z"),
      );

      const consVm = vms.find((v) => v.id === "consultation-cons-resched")!;
      expect(consVm.raw.rawOccurrences?.map((o) => o.id)).toEqual([
        "new-tentative-live",
      ]);

      const trialVm = vms.find((v) => v.id === "trial-trial-pay")!;
      expect(trialVm.pendingPaymentUrl).toBe(`/checkout/plans/trial/trial-pay`);
    });
  });

  describe("Consultant Trial helpers and VM mapping", () => {
    it("populates raw.appointment on mapped trials and resolves TRIAL helper fields", () => {
      const vms = mapConsultantAppointments(
        {
          consultantId: "cp-1",
          appointments: [],
          scheduledTrials: [
            {
              id: "trial-row-1",
              status: "SCHEDULED",
              consulteeProfile: {
                id: "ce-1",
                user: {
                  id: "u-ce-1",
                  name: "Learner Jane",
                  image: null,
                },
              },
              subscriptionPlan: {
                id: "sp-1",
                title: "Backend Mastery",
              },
              appointment: {
                id: "appt-trial-row-1",
                occurrences: [
                  {
                    id: "occ-tr-1",
                    startsAt: "2026-08-01T10:00:00.000Z",
                    endsAt: "2026-08-01T10:30:00.000Z",
                    isTentative: false,
                    completionStatus: "SCHEDULED",
                    meeting: null,
                  },
                ],
              },
            },
          ],
        },
        new Date("2026-08-01T09:50:00.000Z"),
      );

      expect(vms).toHaveLength(1);
      expect(vms[0].raw.appointment).toBeDefined();
      expect(vms[0].raw.appointment?.id).toBe("appt-trial-row-1");

      const trialAppt = {
        id: "appt-trial-1",
        appointmentType: "TRIAL",
        occurrences: [
          {
            id: "occ-dead",
            startsAt: new Date().toISOString(),
            endsAt: new Date(Date.now() + 1800_000).toISOString(),
            isTentative: false,
            completionStatus: "CANCELLED",
          },
        ],
        trial: {
          id: "tr-1",
          status: "SCHEDULED",
          consulteeProfile: {
            user: { name: "Learner Jane", image: "https://img.example/j.png" },
          },
          subscriptionPlan: {
            title: "Backend Mastery",
            trialDurationMinutes: 30,
          },
        },
      } as unknown as TAppointment;

      expect(getAppointmentLifecycleStatus(trialAppt)).toBe("SCHEDULED");
      expect(getConsumeeName(trialAppt)).toBe("Learner Jane");
      expect(getAppointmentTypeAndPlan(trialAppt)).toBe(
        "Trial - Backend Mastery",
      );
      // Because the only occurrence today is CANCELLED, getTodayAppointments must drop it
      expect(getTodayAppointments([trialAppt], "Asia/Kolkata")).toHaveLength(0);
    });
  });
});
