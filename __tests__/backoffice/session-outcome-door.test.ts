/**
 * @jest-environment node
 */

// #1569 A-10 — ops may un-void a session only while nothing was paid for it.
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/booking/class-sessions", () => ({
  onClassSessionVoided: jest.fn(),
}));

import { setSessionOutcome } from "@/lib/backoffice/session-outcomes";
import type { Tx } from "@/lib/prisma";

const voidedTx = (refund: { id: string } | null) =>
  ({
    appointmentOccurrence: {
      findUnique: async () => ({
        id: "occ-1",
        appointmentId: "apt-1",
        ordinal: 3,
        startsAt: new Date("2026-09-01T10:00:00Z"),
        endsAt: new Date("2026-09-01T11:00:00Z"),
        completionStatus: "VOIDED",
        outcome: "CUT_SHORT",
        seatsSettledAt: null,
        deletedAt: null,
        isTentative: false,
        appointment: { classId: "cls-1" },
      }),
      findFirst: async () => null,
    },
    refund: { findFirst: async () => refund },
  }) as unknown as Tx;

it("refuses to overturn a void once an occ: refund exists (409)", async () => {
  const tx = voidedTx({ id: "rf-1" });
  await expect(
    setSessionOutcome(tx, {
      occurrenceId: "occ-1",
      outcome: "HELD",
      actorUserId: "ops-1",
    }),
  ).rejects.toMatchObject({ code: "OUTCOME_SETTLED", httpStatus: 409 });
});

// #1834 — VOIDED → UNVERIFIED is not in the transition map, so the door refuses it.
it("refuses an outcome whose status move the transition map forbids", async () => {
  await expect(
    setSessionOutcome(voidedTx(null), {
      occurrenceId: "occ-1",
      outcome: "INCONCLUSIVE",
      actorUserId: "ops-1",
    }),
  ).rejects.toMatchObject({ code: "TRANSITION_NOT_ALLOWED", httpStatus: 409 });
});
