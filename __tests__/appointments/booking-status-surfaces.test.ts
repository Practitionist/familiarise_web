/**
 * Every surface reads the one status function with the facts it needs: the
 * back office sees a pay-first hold and a trial as stored, the learner's list
 * files a hold they must pay under "Needs you", a refunded booking reads
 * "Refunded" in the list too, and wording follows who the viewer is.
 */

import { staffStatus } from "@/components/dashboard/shared/OperatorAppointmentsClient";
import { bookingStatus } from "@/lib/appointments/booking-status";
import { deriveBucket } from "@/lib/appointments/bucket";
import { buildScheduleModel } from "@/lib/appointments/session-schedule";
import { appointmentStatusChip } from "@/lib/appointments/occurrences";
import { viewerSeatReleased } from "@/lib/appointments/presentation-input";
import { seatLapsedOrReleased } from "@/lib/appointments/status";
import type { TAppointmentDetail } from "@/lib/data/appointment-detail";
import type { StaffAppointment } from "@/lib/data/staff-appointments";

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
    expect(
      seatLapsedOrReleased(
        { seatStatus: "HELD", paid: false, payDeadline: null },
        NOW,
      ),
    ).toBe(true);
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
