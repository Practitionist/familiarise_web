/**
 * Every surface reads the one status function with the facts it needs: the
 * back office sees a pay-first hold and a trial as stored, the learner's list
 * files a hold they must pay under "Needs you", a refunded booking reads
 * "Refunded" in the list too, and wording follows who the viewer is.
 */

import { staffStatus } from "@/components/dashboard/shared/OperatorAppointmentsClient";
import { slotStatus } from "@/components/appointments/SessionTimeline";
import { bookingStatus } from "@/lib/appointments/booking-status";
import { deriveBucket } from "@/lib/appointments/bucket";
import { buildScheduleModel } from "@/lib/appointments/session-schedule";
import {
  appointmentStatusChip,
  isOccurrenceHeld,
  occurrencesOfAppointment,
} from "@/lib/appointments/occurrences";
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
});

describe("a session parked for ops holds its booking's status", () => {
  const WAITING = "Waiting on a decision";

  it("a stored COMPLETED booking with a parked session waits on a decision for every viewer", () => {
    const facts = {
      kind: "SUBSCRIPTION",
      status: "COMPLETED",
      parkedSessions: 1,
    };
    for (const viewer of [
      "CONSULTEE",
      "CONSULTANT",
      "ORG_ADMIN",
      "STAFF",
    ] as const) {
      expect(bookingStatus(facts, viewer)).toMatchObject({
        stage: "AWAITING_DECISION",
        label: WAITING,
        tone: "caution",
      });
    }
    // The host's own event and the back office's event row drop the event word too.
    const webinar = {
      kind: "WEBINAR",
      status: "COMPLETED",
      parkedSessions: 1,
    };
    expect(bookingStatus(webinar, "CONSULTANT").label).toBe(WAITING);
    expect(
      staffStatus(
        staffRow({
          type: "webinar",
          status: "completed",
          parkedSessions: 1,
        }),
      ).label,
    ).toBe(WAITING);
    expect(
      bookingStatus({ ...webinar, parkedSessions: 0 }, "CONSULTANT").label,
    ).toBe("Completed");
  });

  it("a finished 1:1 with a parked session waits; a plan still running stays Confirmed", () => {
    const over = {
      live: 1,
      allTentative: false,
      done: false,
      awaitingOutcome: true,
    };
    expect(
      bookingStatus(
        {
          kind: "CONSULTATION",
          status: "APPROVED",
          sessions: over,
          parkedSessions: 1,
        },
        "CONSULTEE",
      ).label,
    ).toBe(WAITING);
    const plan = {
      kind: "SUBSCRIPTION",
      status: "APPROVED",
      parkedSessions: 1,
    };
    expect(bookingStatus({ ...plan, sessions: over }, "CONSULTEE").label).toBe(
      "Confirmed",
    );
    expect(
      bookingStatus({ ...plan, sessions: over, planEnded: true }, "CONSULTEE")
        .label,
    ).toBe(WAITING);
    // A read without sessions (the back office) knows a one-session booking is over.
    expect(
      staffStatus(staffRow({ status: "approved", parkedSessions: 1 })).label,
    ).toBe(WAITING);
    // The back office reads a plan past its end as over; a running plan stays Confirmed.
    const staffPlan = (planEnded: boolean) =>
      staffStatus(
        staffRow({
          type: "subscription",
          status: "approved",
          parkedSessions: 2,
          planEnded,
        }),
      ).label;
    expect([staffPlan(true), staffPlan(false)]).toEqual([WAITING, "Confirmed"]);
  });

  it("a live booking keeps its word and names its parked sessions under it", () => {
    const live = { live: 8, allTentative: false, done: false };
    const plan = {
      kind: "SUBSCRIPTION",
      status: "APPROVED",
      sessions: live,
      parkedSessions: 2,
    };
    for (const viewer of ["CONSULTEE", "CONSULTANT", "STAFF"] as const) {
      expect(bookingStatus(plan, viewer)).toMatchObject({
        label: "Confirmed",
        line: "2 sessions are waiting on a decision.",
      });
    }
    // A plan waiting for its next placement keeps its prompt first.
    expect(
      bookingStatus(
        { ...plan, planWait: "NEXT_CYCLE" as const, nextBatch: 2 },
        "CONSULTANT",
      ).line,
    ).toBe(
      "Week done. Schedule the next 2. 2 sessions are waiting on a decision.",
    );
    // A booking being moved keeps its move prompt first.
    const moving = bookingStatus(
      {
        ...plan,
        reschedule: {
          by: "CONSULTANT",
          mine: false,
          proposedStartsAt: null,
          originalStartsAt: null,
          expiresAt: null,
        },
        names: { payer: "Charlotte", consultant: "Hannah" },
      },
      "CONSULTEE",
    );
    expect(moving.stage).toBe("BEING_MOVED");
    expect(moving.line).toBe(
      "Hannah asked for a new time. 2 sessions are waiting on a decision.",
    );
    // The host's own live class keeps its event word, with the line.
    expect(
      bookingStatus(
        {
          kind: "CLASS",
          status: "SCHEDULED",
          sessions: live,
          parkedSessions: 1,
        },
        "CONSULTANT",
      ),
    ).toMatchObject({
      label: "Scheduled",
      line: "1 session is waiting on a decision.",
    });
    // The list chip reads a plan's end as its page does.
    const occurrences = occurrencesOfAppointment({
      id: "a2",
      occurrences: [
        {
          id: "o2",
          startsAt: new Date(NOW.getTime() - 3 * 3_600_000),
          endsAt: new Date(NOW.getTime() - 2 * 3_600_000),
          isTentative: false,
          completionStatus: "UNVERIFIED",
          outcome: "NOBODY_JOINED",
        },
      ],
    });
    const row = {
      kind: "SUBSCRIPTION" as const,
      status: "APPROVED",
      occurrences,
      parkedSessions: 1,
    };
    expect(appointmentStatusChip(row, "consultee").label).toBe("Confirmed");
    expect(
      appointmentStatusChip({ ...row, planEnded: true }, "consultee").label,
    ).toBe(WAITING);
  });

  it("a parked session waits on a decision; an unverified one not parked is still verifying", () => {
    const [parked, verifying, delivered] = occurrencesOfAppointment({
      id: "a3",
      occurrences: [
        { outcome: "NOBODY_JOINED", parked: true },
        { outcome: null, parked: false },
        { outcome: "HELD", parked: false, completionStatus: "COMPLETED" },
      ].map((row, i) => ({
        id: `o3-${i}`,
        startsAt: new Date(NOW.getTime() - (5 - i) * 3_600_000),
        endsAt: new Date(NOW.getTime() - (4 - i) * 3_600_000),
        isTentative: false,
        completionStatus: "UNVERIFIED",
        ...row,
      })),
    });
    expect(
      [parked, verifying, delivered].map((o) => slotStatus(o, undefined, NOW)),
    ).toEqual(["waitingDecision", "inconclusive", "completed"]);
  });

  it("a booking waiting on several sessions counts them", () => {
    const facts = {
      kind: "SUBSCRIPTION",
      status: "COMPLETED",
      parkedSessions: 5,
    };
    expect(bookingStatus(facts, "STAFF").line).toBe(
      "5 sessions are in Sessions that need a decision; settlement waits for them.",
    );
    expect(bookingStatus(facts, "CONSULTEE").line).toBe(
      "Our team is checking what happened in 5 sessions. This booking settles once they decide.",
    );
    expect(bookingStatus({ ...facts, parkedSessions: 1 }, "STAFF").line).toBe(
      "A session is in Sessions that need a decision; settlement waits for it.",
    );
  });

  it("an unverified inconclusive or host-absent session is not held; a recorded no-join is", () => {
    const unverified = (outcome: string) => ({
      completionStatus: "UNVERIFIED",
      outcome,
    });
    expect(isOccurrenceHeld(unverified("INCONCLUSIVE"))).toBe(false);
    expect(isOccurrenceHeld(unverified("HOST_ABSENT"))).toBe(false);
    expect(isOccurrenceHeld(unverified("NOBODY_JOINED"))).toBe(true);
    // A list row whose only session is parked never reads Completed.
    const occurrences = occurrencesOfAppointment({
      id: "a1",
      occurrences: [
        {
          id: "o1",
          startsAt: new Date(NOW.getTime() - 3 * 3_600_000),
          endsAt: new Date(NOW.getTime() - 2 * 3_600_000),
          isTentative: false,
          ...unverified("INCONCLUSIVE"),
        },
      ],
    });
    expect(
      appointmentStatusChip(
        { kind: "CONSULTATION", status: "APPROVED", occurrences },
        "consultee",
      ).label,
    ).toBe("Confirmed");
    // A confirmed host-absent verdict is a recorded outcome.
    expect(
      isOccurrenceHeld({ completionStatus: "VOIDED", outcome: "HOST_ABSENT" }),
    ).toBe(true);
  });
});
