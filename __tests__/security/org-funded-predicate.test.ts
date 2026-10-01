/**
 * @jest-environment node
 */

/**
 * "Did the ORG pay for this?" has one answer, and two surfaces were answering
 * it differently.
 *
 * `sponsoredSeatsWhere` (lib/data/org-sponsored-seats.ts) requires a Payment
 * on one of the three org rails; the org appointments list keyed on
 * `Appointment.organizationId` alone. That column is a TAG — checkout stamps it
 * for a `fundingSource: PERSONAL` booking too, where the member's own card paid
 * — so the list published the amount of a member's personal purchase to every
 * MANAGER+ in the org, and act-for-org let the org's OWNER cancel it (refunding
 * the member's card).
 *
 * The rail tuple is module-private in `org-sponsored-seats.ts` and a Prisma
 * `in` filter needs the values at build time, so the list carries its own
 * literal. That duplication is only safe while something pins the two together,
 * which is this file.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findFirst: jest.fn() },
    membership: { findUnique: jest.fn() },
  },
}));

import prisma from "../../lib/prisma";
import { isOrgFundedPaymentMethod } from "../../lib/data/org-sponsored-seats";
import { isActForOrgBooking, isOrgFundedByOrg } from "../../lib/booking/org-actor";
import { buildWhere } from "../../lib/api/scope/list-appointments";

const m = prisma as unknown as {
  payment: { findFirst: jest.Mock };
};

function listWhereClause(): unknown {
  return buildWhere({ scope: { kind: "org", orgId: "org-1" }, userId: "u1" });
}

describe("the org-funded rail tuple", () => {
  it("is the same three rails isOrgFundedPaymentMethod accepts", () => {
    for (const method of ["WALLET", "INVOICE", "LICENSE"]) {
      expect(isOrgFundedPaymentMethod(method)).toBe(true);
    }
    // The PERSONAL rail and a card are the same non-answer, and null/undefined
    // (a Payment with no method yet) must not read as "org funded" either.
    for (const method of ["PERSONAL", "CARD", "CREDITS", "BANK", "", null, undefined]) {
      expect(isOrgFundedPaymentMethod(method)).toBe(false);
    }
  });

  it("the list's WHERE clause is built from exactly those three", () => {
    const fromPredicate = ["WALLET", "INVOICE", "LICENSE"].filter(
      isOrgFundedPaymentMethod,
    );
    expect(listWhereClause()).toMatchObject({
      payment: { some: { paymentMethod: { in: fromPredicate } } },
    });
  });
});

describe("isOrgFundedByOrg — the act-for-org gate", () => {
  const TARGET = {
    organizationId: "org-1",
    consultationId: "cons-1",
    subscriptionId: null,
  };

  beforeEach(() => {
    m.payment.findFirst.mockReset();
  });

  it("accepts each org rail and refuses a member's own card", async () => {
    for (const method of ["WALLET", "INVOICE", "LICENSE"]) {
      m.payment.findFirst.mockResolvedValue({ paymentMethod: method });
      await expect(isOrgFundedByOrg(TARGET, "org-1")).resolves.toBe(true);
    }
    m.payment.findFirst.mockResolvedValue({ paymentMethod: "CARD" });
    await expect(isOrgFundedByOrg(TARGET, "org-1")).resolves.toBe(false);
  });

  it("refuses when the booking has no org payment at all", async () => {
    m.payment.findFirst.mockResolvedValue(null);
    await expect(isOrgFundedByOrg(TARGET, "org-1")).resolves.toBe(false);
  });

  it("reads the booking's own payment, scoped to the acting org", async () => {
    // The query is the gate: pinned to the appointment (so a payment for a
    // different booking can never stand in) and to the org (so org B cannot
    // fund org A's booking by pointing its wallet at it).
    //
    // `objectContaining` on the pair, with the status and retirement filters
    // asserted in their own right below — the previous exact-`toEqual` on the
    // whole `where` meant any added filter failed here, which is how a gate
    // that had to name `paymentStatus` and `deletedAt` came to name neither.
    m.payment.findFirst.mockResolvedValue({ paymentMethod: "WALLET" });
    await isOrgFundedByOrg(TARGET, "org-1");

    expect(m.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          appointment: { consultationId: "cons-1" },
          organizationId: "org-1",
        }),
        select: { paymentMethod: true },
      }),
    );
  });

  it("counts the org's money as paid on SUCCEEDED and PENDING, and only those", async () => {
    // The union is the whole argument: an org rail is SUCCEEDED at creation with
    // no gateway phase, so PENDING is unreachable today and admitting it changes
    // nothing. It is admitted anyway so that the day an org rail gains a
    // two-phase settle, the org has not silently lost authority over its own
    // booking at a gate whose code did not change.
    //
    // FAILED/EXPIRED is the exclusion that matters: the org's money demonstrably
    // did not pay, so admitting it would let an org owner cancel a booking and
    // push the refund onto the member's card.
    m.payment.findFirst.mockResolvedValue({ paymentMethod: "WALLET" });
    await isOrgFundedByOrg(TARGET, "org-1");

    const { where } = m.payment.findFirst.mock.calls[0]![0] as {
      where: { paymentStatus: { in: string[] }; deletedAt: string | null };
    };
    expect(where.paymentStatus).toEqual({ in: ["SUCCEEDED", "PENDING"] });
    // Retired rows are not live funding records — the house clause, and the one
    // thing this gate must never be the last word on.
    expect(where.deletedAt).toBeNull();
  });

  it("uses the subscription key for a subscription booking", async () => {
    m.payment.findFirst.mockResolvedValue({ paymentMethod: "INVOICE" });
    await isOrgFundedByOrg(
      {
        organizationId: "org-1",
        consultationId: null,
        subscriptionId: "subs-1",
      },
      "org-1",
    );
    expect(m.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          appointment: { subscriptionId: "subs-1" },
        }),
      }),
    );
  });
});

describe("isActForOrgBooking stays a shape test, not a funding test", () => {
  it("a tagged-but-personal 1:1 booking is still shape-valid", () => {
    // The tag alone cannot distinguish the two, which is exactly why the
    // funding gate sits on top of it rather than inside it.
    expect(
      isActForOrgBooking({
        organizationId: "org-1",
        consultationId: "cons-1",
        subscriptionId: null,
      }),
    ).toBe(true);
  });
});