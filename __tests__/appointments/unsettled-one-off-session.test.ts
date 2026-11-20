/**
 * @jest-environment node
 */

/**
 * A consultation or trial whose only session was voided, or is parked for
 * review, is not Completed and invites no rating: it reads Confirmed with one
 * line that says what happened and what is owed, on the detail derivation and
 * on the list chip. The make-up date is the session's void plus the make-up
 * window.
 */

import { appointmentStatusChip } from "@/lib/appointments/occurrences";
import { toOccurrenceVM } from "@/lib/appointments/view-model";
import { MAKEUP_WINDOW_DAYS } from "@/lib/booking/misses";
import {
  deriveBookingPresentation,
  type BookingPresentationInput,
  type OccurrenceInput,
} from "@/lib/dashboard/money-state";

const NOW = new Date("2026-11-19T06:00:00.000Z");
const STARTS_AT = new Date("2026-11-18T09:00:00.000Z");
const VOIDED_AT = new Date("2026-11-18T09:40:00.000Z");

const session = (over: Partial<OccurrenceInput>): OccurrenceInput => ({
  id: "occ-1",
  startsAt: STARTS_AT,
  endsAt: new Date(STARTS_AT.getTime() + 30 * 60_000),
  isTentative: false,
  completionStatus: "VOIDED",
  outcome: "CUT_SHORT",
  voidedAt: VOIDED_AT,
  ...over,
});

const paid = {
  id: "p1",
  paymentStatus: "SUCCEEDED",
  paymentMethod: "CARD",
  paymentGateway: "RAZORPAY",
  receiptUrl: null,
  consumerInvoice: null,
  amount: 100_000,
  currency: "INR",
  createdAt: new Date("2026-11-10T06:00:00.000Z"),
};

const booking = (
  over: Partial<BookingPresentationInput>,
): BookingPresentationInput => ({
  appointmentType: "CONSULTATION",
  request: { status: "APPROVED", kind: "CONSULTATION" },
  occurrences: [session({})],
  payments: [paid],
  refunds: [],
  disputes: [],
  childPayments: [],
  sponsorOrgName: null,
  holdExpiresAt: null,
  source: "DIRECT_CHECKOUT",
  names: { payer: "Charlotte", consultant: "Hannah" },
  ...over,
});

const read = (
  input: BookingPresentationInput,
  viewer: "CONSULTANT" | "CONSULTEE",
  attended = true,
) =>
  deriveBookingPresentation(input, viewer, {
    viewerZone: "UTC",
    now: NOW,
    // The rating gate says the learner was in the room.
    heldOccurrenceIds: new Set(attended ? ["occ-1"] : []),
  });

describe("a paid consultation whose only session was voided", () => {
  it("the make-up is due the make-up window after the void", () => {
    expect(MAKEUP_WINDOW_DAYS).toBe(14);
  });

  it("cut short: Confirmed, the remedy and its date, and no rating for the learner", () => {
    const u = read(booking({}), "CONSULTEE");
    expect(u.bookingState).toMatchObject({
      state: "CONFIRMED",
      label: "Confirmed",
      why: "This session was cut short. Hannah owes you a new time by 2 Dec, or you are refunded.",
    });
    expect(u.nextAction.kind).toBe("NONE");
    expect(u.awaitsSettlement).toBe(true);
    expect(u.timeline.find((e) => e.label === "Completed")?.done).toBe(false);
  });

  it("cut short: the expert reads what they owe", () => {
    expect(read(booking({}), "CONSULTANT").bookingState).toMatchObject({
      state: "CONFIRMED",
      label: "Confirmed",
      why: "This session was cut short. You owe Charlotte a new time by 2 Dec, or they are refunded.",
    });
  });

  it("the host did not join", () => {
    const input = booking({
      occurrences: [session({ outcome: "HOST_ABSENT" })],
    });
    expect(read(input, "CONSULTEE").bookingState.why).toBe(
      "Hannah did not join this session. Hannah owes you a new time by 2 Dec, or you are refunded.",
    );
    expect(read(input, "CONSULTANT").bookingState.why).toBe(
      "You did not join this session. You owe Charlotte a new time by 2 Dec, or they are refunded.",
    );
  });

  it("a platform issue blames nobody", () => {
    const input = booking({
      occurrences: [session({ outcome: "PLATFORM_OUTAGE" })],
    });
    expect(read(input, "CONSULTEE").bookingState.why).toBe(
      "This session was stopped by a problem on our side. You are owed a new time by 2 Dec, or you are refunded.",
    );
    expect(read(input, "CONSULTANT").bookingState.why).toBe(
      "This session was stopped by a problem on our side. Charlotte is owed a new time by 2 Dec, or they are refunded.",
    );
  });

  it("a free consultation promises the new time, never a refund", () => {
    const free = { ...paid, amount: 0, legs: [] };
    const u = read(booking({ payments: [free] }), "CONSULTEE");
    expect(u.bookingState.why).toBe(
      "This session was cut short. Hannah owes you a new time by 2 Dec.",
    );
  });

  it("reads Completed and invites a rating once the make-up is delivered", () => {
    const u = read(
      booking({
        occurrences: [
          session({}),
          session({
            id: "occ-2",
            completionStatus: "COMPLETED",
            outcome: "HELD",
            voidedAt: null,
          }),
        ],
      }),
      "CONSULTEE",
    );
    expect(u.bookingState.state).toBe("COMPLETED");
    expect(u.nextAction.kind).toBe("RATE");
    expect(u.awaitsSettlement).toBe(false);
  });

  it("a stored Completed booking still reads Completed", () => {
    const u = read(
      booking({ request: { status: "COMPLETED", kind: "CONSULTATION" } }),
      "CONSULTEE",
    );
    expect(u.bookingState.label).toBe("Completed");
  });
});

describe("a one-off session parked for review", () => {
  const parked = booking({
    occurrences: [
      session({
        completionStatus: "UNVERIFIED",
        outcome: "INCONCLUSIVE",
        voidedAt: null,
      }),
    ],
  });

  it("reads Confirmed while we confirm what happened, with no rating", () => {
    for (const viewer of ["CONSULTEE", "CONSULTANT"] as const) {
      const u = read(parked, viewer);
      expect(u.bookingState).toMatchObject({
        state: "CONFIRMED",
        label: "Confirmed",
        why: "This session's time has passed. We're confirming what happened.",
      });
      expect(u.nextAction.kind).toBe("NONE");
      expect(u.awaitsSettlement).toBe(true);
    }
  });
});

describe("a trial whose session was voided", () => {
  const trial = (payments: BookingPresentationInput["payments"]) =>
    booking({
      appointmentType: "TRIAL",
      request: { status: "SCHEDULED", kind: "TRIAL" },
      source: null,
      payments,
    });

  it("a free trial says what happened and promises nothing", () => {
    const u = read(trial([]), "CONSULTEE");
    expect(u.bookingState).toMatchObject({
      state: "CONFIRMED",
      label: "Confirmed",
      why: "This session was cut short.",
    });
    expect(u.nextAction.kind).toBe("NONE");
  });

  it("a paid trial waits on our review, with no date and no refund promise", () => {
    expect(read(trial([paid]), "CONSULTEE").bookingState.why).toBe(
      "This session was cut short. Our support team is reviewing it.",
    );
  });
});

describe("bookings this rule leaves alone", () => {
  it("a plan with a voided session completes at its plan end as before", () => {
    const plan = booking({
      appointmentType: "SUBSCRIPTION",
      request: { status: "APPROVED", kind: "SUBSCRIPTION" },
      entitlement: { remaining: 0, nextBatch: 0, planEnded: true },
    });
    expect(read(plan, "CONSULTEE").bookingState.state).toBe("COMPLETED");
  });

  it("a delivered consultation is Completed and can be rated", () => {
    const u = read(
      booking({
        occurrences: [
          session({
            completionStatus: "COMPLETED",
            outcome: "HELD",
            voidedAt: null,
          }),
        ],
      }),
      "CONSULTEE",
    );
    expect(u.bookingState.state).toBe("COMPLETED");
    expect(u.nextAction.kind).toBe("RATE");
  });
});

describe("the list chip agrees with the detail page", () => {
  const vm = (completionStatus: string, kind: "CONSULTATION" | "TRIAL") => ({
    kind,
    status: kind === "TRIAL" ? "SCHEDULED" : "APPROVED",
    paid: true,
    occurrences: [
      toOccurrenceVM({
        id: "occ-1",
        appointmentId: "appt-1",
        startsAt: STARTS_AT,
        endsAt: new Date(STARTS_AT.getTime() + 30 * 60_000),
        isTentative: false,
        completionStatus,
        outcome: "CUT_SHORT",
      }),
    ],
  });

  it.each([
    ["VOIDED", "CONSULTATION"],
    ["UNVERIFIED", "CONSULTATION"],
    ["VOIDED", "TRIAL"],
  ] as const)("%s %s reads Confirmed, not Completed", (status, kind) => {
    for (const role of ["consultee", "consultant"] as const) {
      expect(appointmentStatusChip(vm(status, kind), role).label).toBe(
        "Confirmed",
      );
    }
  });

  it("a delivered one reads Completed", () => {
    expect(
      appointmentStatusChip(vm("COMPLETED", "CONSULTATION"), "consultee").label,
    ).toBe("Completed");
  });
});
