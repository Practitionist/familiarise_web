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

import { readFileSync } from "fs";
import { join } from "path";

import prisma from "../../lib/prisma";
import { isOrgFundedPaymentMethod } from "../../lib/data/org-sponsored-seats";
import { isActForOrgBooking, isOrgFundedByOrg } from "../../lib/booking/org-actor";
import { buildWhere } from "../../lib/api/scope/list-appointments";

const SRC = readFileSync(
  join(process.cwd(), "lib/api/scope/list-appointments.ts"),
  "utf8",
);
const m = prisma as unknown as {
  payment: { findFirst: jest.Mock };
};

/** The literal the Prisma `in` filter is built from, read out of the source. */
function listWhereClause(): unknown {
  const w = buildWhere({ scope: { kind: "org", orgId: "org-1" }, userId: "u1" });
  return w;
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
    // Pinned by value, not by a second copy of the list: the source literal and
    // the predicate have to agree, and reading the literal out of the file is
    // what makes a rename or a fourth rail fail here instead of in production.
    const match = /const ORG_FUNDED_PAYMENT_METHODS = (\[[^\]]*\]);/.exec(SRC);
    expect(match).not.toBeNull();
    const fromSource = JSON.parse(
      (match as RegExpExecArray)[1].replace(/'/g, '"'),
    ) as string[];
    const fromPredicate = ["WALLET", "INVOICE", "LICENSE"].filter(
      isOrgFundedPaymentMethod,
    );
    expect(fromSource).toEqual(fromPredicate);
    expect(listWhereClause()).toMatchObject({
      payment: { some: { paymentMethod: { in: fromPredicate } } },
    });
  });

  it("the payer include applies the same clause as the WHERE", () => {
    // Two filters on one surface must not drift: the WHERE decides which rows
    // are listed, the include decides whose payment is named as the payer.
    expect(SRC).toContain("paymentMethod: { in: ORG_FUNDED_PAYMENT_METHODS }");
    expect(SRC.match(/paymentMethod: \{ in: ORG_FUNDED_PAYMENT_METHODS \}/g))
      .toHaveLength(2);
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
    m.payment.findFirst.mockResolvedValue({ paymentMethod: "WALLET" });
    await isOrgFundedByOrg(TARGET, "org-1");

    expect(m.payment.findFirst).toHaveBeenCalledWith({
      where: {
        appointment: { consultationId: "cons-1" },
        organizationId: "org-1",
      },
      select: { paymentMethod: true },
    });
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