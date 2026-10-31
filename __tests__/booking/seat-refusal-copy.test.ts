/**
 * @jest-environment node
 */

/**
 * A seat leave, class exit or host removal refused because another refund
 * holds the payment says the seat couldn't be released yet, never that a
 * booking couldn't be cancelled; the host's removal page shows that sentence.
 */
import fs from "fs";
import path from "path";

import { heldMarkerRefusal } from "@/lib/payments/operations/refund-owed";

const txWith = (refundOwedAttempts: number) => ({
  payment: {
    findUnique: async () => ({
      refundOwedKey: "cancel:apt-1",
      refundOwedAttempts,
      disputes: [],
    }),
  },
});

describe("heldMarkerRefusal copy", () => {
  it.each([
    [3, "REFUND_NEEDS_SUPPORT"],
    [0, "REFUND_IN_PROGRESS"],
  ])(
    "a seat held by a marker at %i attempts says the seat wasn't released",
    async (attempts, code) => {
      const refusal = await heldMarkerRefusal(
        txWith(attempts) as never,
        "pay-1",
        { seatId: "seat-1" },
        "seat",
      );
      expect(refusal.code).toBe(code);
      expect(refusal.userMessage).toMatch(
        /^This seat couldn't be released yet/,
      );
      expect(refusal.userMessage).not.toMatch(/cancel/i);
    },
  );

  it("a whole booking still says it can't be cancelled yet", async () => {
    const refusal = await heldMarkerRefusal(txWith(3) as never, "pay-1");
    expect(refusal.userMessage).toMatch(/before it can be cancelled/);
  });
});

it("the host removal page shows the server's sentence for a refusal", () => {
  const source = fs.readFileSync(
    path.join(
      process.cwd(),
      "app/dashboard/consultant/[consultantId]/(features)/appointments/participants/[eventType]/[eventId]/page.tsx",
    ),
    "utf8",
  );
  const thrown = source.indexOf(
    "throw new RemovalRefusedError(body.data.error)",
  );
  const generic = source.indexOf(
    'throw new Error("Failed to remove participant")',
  );
  expect(thrown).toBeGreaterThan(-1);
  expect(generic).toBeGreaterThan(thrown);
  const handled = source.indexOf("err instanceof RemovalRefusedError");
  const unconfirmed = source.indexOf("Could not confirm the removal");
  expect(handled).toBeGreaterThan(-1);
  expect(unconfirmed).toBeGreaterThan(handled);
  expect(source).toMatch(/description: err\.message/);
});
