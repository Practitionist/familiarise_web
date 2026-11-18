/**
 * @jest-environment node
 */

/**
 * A staff participant row is not a seat. When its user buys a seat, the write
 * takes the row over as a new learner seat: one row, dated at the purchase,
 * linked to the purchase's payment and counted once.
 */

import {
  linkParticipantsToPayment,
  recordParticipants,
  transitionParticipant,
} from "@/lib/booking/participants";
import { seatHoldingParticipant } from "@/utils/scheduling-engine/occupancyPolicy";
import { matchesWhere, memTable, type Where } from "../fixtures/mem-db";

type Tx = Parameters<typeof recordParticipants>[0];

const APPOINTMENT = "apt-1";
const BUYER = "former-collaborator";
const LONG_AGO = new Date("2026-01-01T00:00:00Z");

/** An event whose former collaborator still has their old staff row. */
function eventWith(staffRowStatus: string) {
  const seats = memTable(
    [
      {
        id: "staff-row",
        appointmentId: APPOINTMENT,
        userId: BUYER,
        role: "COLLABORATOR",
        status: staffRowStatus,
        paymentId: null,
        organizationId: "old-org",
        refundWindowHours: 48,
        sessionsPurchased: 3,
        createdAt: LONG_AGO,
      },
    ],
    "seat",
    { unique: [["appointmentId", "userId"]] },
  );
  const tx = { appointmentParticipant: seats } as unknown as Tx;
  const buyerRows = () => seats.rows.filter((row) => row.userId === BUYER);
  const seatsCounted = () =>
    seats.rows.filter((row) =>
      matchesWhere(row, seatHoldingParticipant(new Date()) as Where),
    ).length;
  return { tx, buyerRows, seatsCounted };
}

const buySeat = async (tx: Tx) => {
  await recordParticipants(
    tx,
    APPOINTMENT,
    [{ userId: BUYER, role: "CONSULTEE" }],
    { status: "HELD", organizationId: "payer-org" },
  );
  await linkParticipantsToPayment(tx, APPOINTMENT, "pay-new", BUYER);
};

describe("a former collaborator buys a seat", () => {
  it.each(["CONFIRMED", "CANCELLED"])(
    "turns their old %s staff row into one learner seat on the new payment",
    async (staffRowStatus) => {
      const event = eventWith(staffRowStatus);
      expect(event.seatsCounted()).toBe(0);
      const boughtAt = Date.now();

      await buySeat(event.tx);

      expect(event.buyerRows()).toEqual([
        expect.objectContaining({
          id: "staff-row",
          role: "CONSULTEE",
          status: "HELD",
          paymentId: "pay-new",
          organizationId: "payer-org",
          refundWindowHours: null,
          sessionsPurchased: null,
        }),
      ]);
      // The seat is as old as the purchase, never as old as the staff row.
      const { createdAt } = event.buyerRows()[0];
      expect(
        createdAt instanceof Date ? createdAt.getTime() : 0,
      ).toBeGreaterThanOrEqual(boughtAt);
      expect(event.seatsCounted()).toBe(1);
    },
  );

  it("leaves the seat as it stands when the write is repeated after the capture", async () => {
    const event = eventWith("CONFIRMED");
    await buySeat(event.tx);
    await transitionParticipant(
      event.tx,
      { appointmentId: APPOINTMENT, userId: BUYER },
      "CONFIRMED",
    );
    const confirmed = { ...event.buyerRows()[0] };

    await buySeat(event.tx);

    expect(event.buyerRows()).toEqual([confirmed]);
    expect(event.seatsCounted()).toBe(1);
  });

  it("gives the host's own row the same takeover", async () => {
    const event = eventWith("CONFIRMED");
    await recordParticipants(
      event.tx,
      APPOINTMENT,
      [{ userId: BUYER, role: "CONSULTANT" }],
      { status: "CONFIRMED" },
    );
    expect(event.buyerRows()).toEqual([
      expect.objectContaining({ role: "CONSULTANT", status: "CONFIRMED" }),
    ]);
  });
});
