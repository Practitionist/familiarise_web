/**
 * How an ended booking explains itself: a hold the learner closed by
 * requesting again says so on the header, the list line and the Timeline,
 * for the learner and the expert alike, and a cancellation with no known
 * actor or date leaves the reason slot empty instead of repeating the chip.
 */

import { bookingStatus } from "@/lib/appointments/booking-status";
import {
  deriveBookingPresentation,
  type BookingPresentationInput,
} from "@/lib/dashboard/money-state";

const NOW = new Date("2026-11-20T18:05:00Z");
const CLOSED_AT = new Date("2026-11-20T18:05:00Z");
const WINDOW_END = new Date("2026-11-10T14:05:00Z");

const requestedAgain = {
  fromStatus: "PENDING",
  toStatus: "EXPIRED",
  reason: "REQUESTED_AGAIN",
  by: "REQUESTER" as const,
  createdAt: CLOSED_AT,
};

const lapsedHold = (history: BookingPresentationInput["history"]) =>
  deriveBookingPresentation(
    {
      appointmentType: "CONSULTATION",
      request: {
        status: "EXPIRED",
        kind: "CONSULTATION",
        bookedAt: new Date("2026-11-10T13:35:00Z"),
      },
      occurrences: [],
      payments: [
        {
          id: "pay-1",
          paymentStatus: "EXPIRED",
          paymentMethod: "CARD",
          paymentGateway: "RAZORPAY",
          receiptUrl: null,
          consumerInvoice: null,
          createdAt: new Date("2026-11-10T13:35:00Z"),
          amount: 50_000,
          currency: "INR",
          expiresAt: WINDOW_END,
          gatewayOrderMinted: true,
        },
      ],
      refunds: [],
      disputes: [],
      childPayments: [],
      sponsorOrgName: null,
      holdExpiresAt: WINDOW_END,
      history,
      source: "DIRECT_CHECKOUT",
      names: { payer: "Daniel Brown", consultant: "Lauren Anderson" },
    },
    "CONSULTEE",
    { viewerZone: "UTC", now: NOW },
  );

const closedHold = (viewer: "CONSULTEE" | "CONSULTANT") =>
  bookingStatus(
    {
      kind: "CONSULTATION",
      status: "EXPIRED",
      source: "DIRECT_CHECKOUT",
      history: [requestedAgain],
      names: { payer: "Daniel Brown", consultant: "Lauren Anderson" },
    },
    viewer,
    { now: NOW },
  );

describe("a hold closed by Request again", () => {
  it("says so on the header, and the expert side names the learner by role in both places", () => {
    expect(closedHold("CONSULTEE").line).toBe(
      "You closed this payment link and requested again.",
    );
    expect(closedHold("CONSULTANT").line).toBe(
      "The learner closed this payment link and requested again.",
    );
  });

  it("shows the request on the Timeline at the click, not the lapsed window", () => {
    const events = lapsedHold([requestedAgain]).timeline;
    const last = events.at(-1);
    expect(last?.label).toBe("You requested again");
    expect(last?.at?.toISOString()).toBe(CLOSED_AT.toISOString());
    expect(events.map((e) => e.label)).not.toContain("Payment link expired");
  });

  it("keeps the expired-link row at the window end for a hold that simply lapsed", () => {
    const last = lapsedHold([
      { fromStatus: "PENDING", toStatus: "EXPIRED", reason: null },
    ]).timeline.at(-1);
    expect(last?.label).toBe("Payment link expired");
    expect(last?.at?.toISOString()).toBe(WINDOW_END.toISOString());
  });
});

describe("a cancelled booking's reason line", () => {
  const cancelled = (extra: object) =>
    bookingStatus(
      { kind: "CONSULTATION", status: "CANCELLED", ...extra },
      "CONSULTANT",
      { now: NOW, zone: "UTC" },
    );

  it("is empty when no history edge or date says who or when", () => {
    expect(cancelled({}).line).toBe("");
  });

  it("names who and when once the history carries it", () => {
    expect(
      cancelled({
        history: [
          {
            fromStatus: "CONFIRMED",
            toStatus: "CANCELLED",
            by: "REQUESTER",
            createdAt: new Date("2026-11-12T10:00:00Z"),
          },
        ],
        names: { payer: "Daniel Brown", consultant: "Lauren Anderson" },
      }).line,
    ).toBe("Cancelled by Daniel Brown on 12 Nov.");
  });
});
