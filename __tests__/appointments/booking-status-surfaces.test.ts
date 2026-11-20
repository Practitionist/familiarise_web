/**
 * Every surface reads the one status function with the facts it needs: the
 * back office sees a pay-first hold and a trial as stored, the learner's list
 * files a hold they must pay under "Needs you", a refunded booking reads
 * "Refunded" in the list too, and wording follows who the viewer is.
 */

import {
  rowStatus,
  type AppointmentRow,
} from "@/app/dashboard/organization/[orgId]/appointments/AppointmentsPageClient";
import { staffStatus } from "@/components/dashboard/shared/OperatorAppointmentsClient";
import { bookingStatus } from "@/lib/appointments/booking-status";
import { deriveBucket } from "@/lib/appointments/bucket";
import { UNPLACED_PLAN_REASON } from "@/lib/booking/unplaced-plan";
import { buildScheduleModel } from "@/lib/appointments/session-schedule";
import { appointmentStatusChip } from "@/lib/appointments/occurrences";
import { viewerSeatReleased } from "@/lib/appointments/presentation-input";
import { seatLapsedOrReleased } from "@/lib/appointments/status";
import type { TAppointmentDetail } from "@/lib/data/appointment-detail";
import type { StaffAppointment } from "@/lib/data/staff-appointments-schema";

const NOW = new Date("2026-11-14T10:00:00Z");
const staffRow = (over: Partial<StaffAppointment>) =>
  ({
    type: "consultation",
    status: "pending",
    bookingSource: null,
    payment: { status: "PENDING" },
    reschedule: null,
    ...over,
  }) as StaffAppointment;

describe("the one status on every surface", () => {
  it("the back office reads a pay-first hold and a trial as stored", () => {
    expect(
      staffStatus(staffRow({ bookingSource: "DIRECT_CHECKOUT" })).label,
    ).toBe("Awaiting payment");
    expect(
      staffStatus(staffRow({ bookingSource: "REQUEST_SUBMITTED" })).label,
    ).toBe("Requested");
    expect(
      staffStatus(staffRow({ type: "trial", status: "awaiting_payment" }))
        .label,
    ).toBe("Awaiting payment");
    expect(
      staffStatus(staffRow({ type: "trial", status: "cancelled" })).label,
    ).toBe("Cancelled");
  });

  it("a hold the learner must pay is filed under Needs you, a closed one under Cancelled", () => {
    const hold = {
      status: "PENDING",
      occurrences: [],
      source: "DIRECT_CHECKOUT",
      now: NOW,
    };
    expect(deriveBucket({ ...hold, holdOpen: true }, "consultee")).toEqual({
      bucket: "needsAction",
      needsActionReason: "PAY_NOW",
    });
    expect(deriveBucket({ ...hold, holdOpen: false }, "consultee").bucket).toBe(
      "cancelled",
    );
  });

  it("a refunded booking reads Refunded in the list as on its page", () => {
    expect(
      appointmentStatusChip(
        {
          status: "CANCELLED",
          kind: "CONSULTATION",
          refunded: { paise: 50_000, currency: "INR", at: NOW },
        },
        "consultee",
      ).label,
    ).toBe("Refunded");
  });

  it("the placement promise holds only until its deadline", () => {
    const plan = {
      kind: "SUBSCRIPTION",
      status: "PENDING",
      paid: true,
      planWait: "CYCLE_1" as const,
      names: { payer: "Charlotte", consultant: "Hannah" },
    };
    const line = (allocateBy: Date) =>
      bookingStatus({ ...plan, allocateBy }, "CONSULTEE", {
        now: NOW,
        zone: "UTC",
      }).line;
    expect(line(new Date(NOW.getTime() + 3_600_000))).toContain(
      "within 48 hours",
    );
    expect(line(new Date(NOW.getTime() - 3_600_000))).toMatch(
      /has not arranged times yet/,
    );
  });

  it("someone who did not propose a move reads it in the third person", () => {
    const s = bookingStatus(
      {
        kind: "CONSULTATION",
        status: "PENDING",
        reschedule: {
          by: "CONSULTANT",
          mine: false,
          proposedStartsAt: null,
          originalStartsAt: null,
          expiresAt: null,
        },
        names: { payer: "Charlotte", consultant: "Hannah" },
      },
      "CONSULTANT",
    );
    expect(s.line).toMatch(/^Hannah asked/);
  });

  it("a seat given back or lapsed holds no place, and its page knows it", () => {
    expect(seatLapsedOrReleased({ seatStatus: "CANCELLED" }, NOW)).toBe(true);
    // Lapsed only on evidence: an expired payment, not an unknown window.
    expect(
      seatLapsedOrReleased(
        { seatStatus: "HELD", paid: false, payDeadline: null, payLapsed: true },
        NOW,
      ),
    ).toBe(true);
    expect(
      seatLapsedOrReleased(
        { seatStatus: "HELD", paid: false, payDeadline: null },
        NOW,
      ),
    ).toBe(false);
    expect(
      seatLapsedOrReleased(
        {
          seatStatus: "HELD",
          paid: false,
          payDeadline: new Date(NOW.getTime() + 60_000),
        },
        NOW,
      ),
    ).toBe(false);
    const detail = {
      appointment: {
        webinar: { id: "w1" },
        class: null,
        participants: [],
        payment: [{ userId: "u1" }],
      },
    } as unknown as TAppointmentDetail;
    expect(viewerSeatReleased(detail, "u1")).toBe(true);
  });

  it("a plan is not Completed while it runs, even when its placed sessions are held", () => {
    const held = { live: 2, allTentative: false, done: true };
    const plan = { kind: "SUBSCRIPTION", status: "APPROVED", sessions: held };
    expect(bookingStatus(plan, "CONSULTEE").label).toBe("Confirmed");
    expect(bookingStatus({ ...plan, planEnded: true }, "CONSULTEE").label).toBe(
      "Completed",
    );
  });

  it("a cancelled session is listed in its week but does not count toward it", () => {
    const at = (h: number) => new Date(Date.UTC(2026, 10, 16, h));
    const rows = [
      { key: "a", startsAt: at(9), endsAt: at(10), cancelled: false },
      { key: "b", startsAt: at(12), endsAt: at(13), cancelled: true },
    ];
    const model = buildScheduleModel(rows, "UTC", {
      sessionsPerWeek: 2,
      counts: (r) => !r.cancelled,
    });
    expect(model.weeks[0]).toMatchObject({ counted: 1, short: true });
    expect(model.weeks[0].sessions).toHaveLength(2);
  });

  it("a request's answer window is its kind's: 48 hours for a 1:1, 30 days for a plan", () => {
    const names = { payer: "Charlotte", consultant: "Hannah" };
    const waiting = (kind: string) =>
      bookingStatus(
        { kind, status: "PENDING", source: "REQUEST_SUBMITTED", names },
        "CONSULTEE",
      ).line;
    expect(waiting("CONSULTATION")).toBe(
      "Waiting for Hannah to answer (within 48 hours).",
    );
    expect(waiting("SUBSCRIPTION")).toBe(
      "Waiting for Hannah to answer (within 30 days).",
    );
    const unanswered = (kind: string, viewer: "CONSULTEE" | "CONSULTANT") =>
      bookingStatus(
        {
          kind,
          status: "EXPIRED",
          source: "REQUEST_SUBMITTED",
          history: [{ fromStatus: "PENDING", toStatus: "EXPIRED" }],
          names,
        },
        viewer,
      ).line;
    expect(unanswered("CONSULTATION", "CONSULTEE")).toBe(
      "The expert did not answer in 48 hours.",
    );
    expect(unanswered("SUBSCRIPTION", "CONSULTEE")).toBe(
      "The expert did not answer in 30 days.",
    );
    expect(unanswered("SUBSCRIPTION", "CONSULTANT")).toBe(
      "You did not answer in 30 days.",
    );
  });

  it("an organisation reads a webinar or class it lists as the event, a draft included", () => {
    const orgRow = (over: Partial<AppointmentRow>) =>
      ({
        id: "appt-1",
        appointmentType: "WEBINAR",
        createdAt: NOW.toISOString(),
        organizationId: "org-1",
        occurrences: [
          {
            id: "occ-1",
            startsAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
            endsAt: new Date(NOW.getTime() + 90_000_000).toISOString(),
            isTentative: false,
            completionStatus: "SCHEDULED",
          },
        ],
        consultation: null,
        subscription: null,
        webinar: null,
        class: null,
        ...over,
      }) as AppointmentRow;
    const event = (status: string) => ({
      status,
      webinarPlan: { title: "Workshop" },
    });
    expect(rowStatus(orgRow({ webinar: event("DRAFT") })).label).toBe("Draft");
    expect(rowStatus(orgRow({ webinar: event("SCHEDULED") })).label).toBe(
      "Scheduled",
    );
    expect(
      rowStatus(
        orgRow({
          appointmentType: "CLASS",
          class: { status: "SCHEDULED", classPlan: { title: "Cohort" } },
        }),
      ).label,
    ).toBe("Scheduled");
    // A 1:1 keeps its booking words.
    const consultation = {
      status: "APPROVED",
      consultationPlan: { title: "Career chat" },
      requestedBy: {
        user: { id: "u-l", name: "Charlotte", email: "c@x.test" },
      },
    };
    expect(
      rowStatus(orgRow({ appointmentType: "CONSULTATION", consultation }))
        .label,
    ).toBe("Confirmed");
    // And one whose only session was voided is not Completed there either.
    expect(
      rowStatus(
        orgRow({
          appointmentType: "CONSULTATION",
          consultation,
          occurrences: [
            {
              id: "occ-1",
              startsAt: new Date(NOW.getTime() - 90_000_000).toISOString(),
              endsAt: new Date(NOW.getTime() - 86_400_000).toISOString(),
              isTentative: false,
              completionStatus: "VOIDED",
            },
          ],
        }),
      ).label,
    ).toBe("Confirmed");
  });

  it("the expert's dated placement line is for a plan awaiting its first times only", () => {
    const paidOn = new Date("2026-11-04T04:30:00Z");
    const options = { now: NOW, zone: "UTC" };
    const parked = {
      kind: "CONSULTATION",
      status: "APPROVED",
      paid: true,
      sessions: { live: 0, allTentative: false, done: false },
      allocateBy: paidOn,
    };
    expect(bookingStatus(parked, "CONSULTANT", options)).toMatchObject({
      label: "Confirmed",
      line: "Place the sessions on the calendar.",
    });
    const plan = {
      kind: "SUBSCRIPTION",
      status: "PENDING",
      paid: true,
      planWait: "CYCLE_1" as const,
      allocateBy: paidOn,
    };
    expect(bookingStatus(plan, "CONSULTANT", options).line).toBe(
      "Paid. Place the first sessions by Wed 4 Nov, 4:30 AM.",
    );
  });

  it("a paid plan that expired unplaced says the expert did not place it, never that payment lapsed", () => {
    const expired = {
      kind: "SUBSCRIPTION",
      status: "EXPIRED",
      source: "DIRECT_CHECKOUT",
      paid: true,
      history: [
        {
          fromStatus: "PENDING",
          toStatus: "EXPIRED",
          reason: UNPLACED_PLAN_REASON,
        },
      ],
    };
    expect(bookingStatus(expired, "CONSULTEE")).toMatchObject({
      stage: "CANCELLED",
      label: "Cancelled",
      line: "The expert did not place the sessions in time.",
    });
    expect(bookingStatus(expired, "CONSULTANT").line).toBe(
      "You did not place the sessions in time.",
    );
  });

  it("a paid booking never reads as a payment lapse, whatever ended it", () => {
    const paid = {
      kind: "CONSULTATION",
      source: "DIRECT_CHECKOUT",
      paid: true,
      unpaidLinkSeen: true,
    };
    const systemEdge = (toStatus: string) => [
      { fromStatus: "PENDING", toStatus, by: null },
    ];
    for (const facts of [
      { ...paid, status: "EXPIRED" },
      { ...paid, status: "EXPIRED", history: systemEdge("EXPIRED") },
      { ...paid, status: "CANCELLED", history: systemEdge("CANCELLED") },
    ]) {
      const status = bookingStatus(facts, "CONSULTEE");
      expect(status.stage).not.toBe("PAYMENT_LAPSED");
      expect(status.line).not.toContain("Payment was not completed");
    }
    // Unpaid, the same edges are still a lapsed payment.
    expect(
      bookingStatus(
        {
          ...paid,
          paid: false,
          status: "CANCELLED",
          history: systemEdge("CANCELLED"),
        },
        "CONSULTEE",
      ).stage,
    ).toBe("PAYMENT_LAPSED");
  });
});
