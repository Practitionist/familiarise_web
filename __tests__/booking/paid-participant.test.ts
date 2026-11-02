/**
 * @jest-environment node
 */

/**
 * `paidParticipant` is the predicate a group-event room uses to admit a seat.
 * It must admit what has been paid for and nothing that is merely held.
 */

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));

import {
  PAID_PARTICIPANT_STATUSES,
  liveParticipant,
  paidParticipant,
} from "@/lib/booking/participants";

describe("paidParticipant", () => {
  it("admits confirmed and attended seats, and a held seat whose payment succeeded", () => {
    expect(paidParticipant("u1")).toEqual({
      userId: "u1",
      OR: [
        { status: { in: ["CONFIRMED", "ATTENDED"] } },
        { status: "HELD", payment: { is: { paymentStatus: "SUCCEEDED" } } },
      ],
    });
  });

  it("never lists a bare HELD status, so an unpaid hold is not admitted", () => {
    expect(PAID_PARTICIPANT_STATUSES).not.toContain("HELD");
    const bareStatuses = (paidParticipant().OR ?? []).flatMap((clause) =>
      "status" in clause && typeof clause.status === "object" && clause.status
        ? ((clause.status as { in?: string[] }).in ?? [])
        : [],
    );
    expect(bareStatuses).not.toContain("HELD");
  });

  it("scopes to a user only when one is given", () => {
    expect(paidParticipant()).not.toHaveProperty("userId");
    expect(paidParticipant("u2")).toHaveProperty("userId", "u2");
  });

  it("is strictly narrower than the live roster predicate", () => {
    expect(liveParticipant().status).toEqual({
      in: ["HELD", "CONFIRMED", "ATTENDED"],
    });
    expect(paidParticipant()).not.toHaveProperty("status");
  });
});
