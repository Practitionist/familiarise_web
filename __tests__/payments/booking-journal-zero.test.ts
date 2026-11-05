/**
 * @jest-environment node
 */

/**
 * Only a booking that moved no money skips its journal; a paid booking that
 * computed no lines still reaches `postLedgerTxn`, which refuses it.
 */
import { bookingNeedsJournal } from "@/lib/payments/payouts/earnings-service";

describe("bookingNeedsJournal", () => {
  it("skips the journal for a ₹0 booking with no lines", () => {
    expect(bookingNeedsJournal(0, 0)).toBe(false);
  });

  it("keeps the journal for a paid booking that computed no lines", () => {
    expect(bookingNeedsJournal(50_000, 0)).toBe(true);
  });

  it("keeps the journal whenever there are lines", () => {
    expect(bookingNeedsJournal(0, 2)).toBe(true);
    expect(bookingNeedsJournal(50_000, 3)).toBe(true);
  });
});
