/**
 * @jest-environment node
 */

// Invariant: a paid session nobody joined, or whose room never existed, is held for a human; it neither completes nor releases earnings.

jest.mock("../../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  withCronLock: (_key: string, _opts: unknown, fn: () => unknown) => fn(),
}));

import { AWAITING_HUMAN, needsHumanWhere } from "@/lib/booking/misses";
import { RELEASABLE_PAYMENT } from "@/scripts/earnings/release-earnings";

type Row = Record<string, unknown>;
const OPS = new Set(["in", "notIn", "not", "lt", "lte", "gt", "gte"]);

/** Just enough of Prisma's `where` semantics to evaluate these predicates in memory. */
function matches(row: Row | null | undefined, where: object): boolean {
  if (!row) return false;
  return Object.entries(where).every(([key, cond]) => {
    if (key === "AND") return [cond].flat().every((w) => matches(row, w));
    if (key === "OR") return (cond as object[]).some((w) => matches(row, w));
    if (key === "NOT") return ![cond].flat().some((w) => matches(row, w));
    const value = row[key];
    if (cond === null || typeof cond !== "object") return value === cond;
    if (Array.isArray(value)) {
      const c = cond as { some?: object; none?: object; every?: object };
      const rows = value as Row[];
      if (c.some && !rows.some((r) => matches(r, c.some!))) return false;
      if (c.none && rows.some((r) => matches(r, c.none!))) return false;
      return !c.every || rows.every((r) => matches(r, c.every!));
    }
    const ops = Object.keys(cond);
    if (ops.length > 0 && ops.every((op) => OPS.has(op))) {
      const c = cond as { in?: unknown[]; not?: unknown };
      if (c.in && !c.in.includes(value)) return false;
      return !("not" in c) || value !== c.not;
    }
    return matches(value as Row, cond);
  });
}

const paid = [{ paymentStatus: "SUCCEEDED", deletedAt: null }];
const slot = (outcome: string, payment: Row[]) => ({
  completionStatus: "UNVERIFIED",
  deletedAt: null,
  isTentative: false,
  outcome,
  meeting: outcome === "OFFLINE" ? null : { endedReason: "empty" },
  appointment: { payment },
});

describe.each(["NOBODY_JOINED", "OFFLINE"])("a paid %s session", (outcome) => {
  const occurrence = slot(outcome, paid);

  it("is awaiting a human and listed in the ops queue", () => {
    expect(matches(occurrence, AWAITING_HUMAN)).toBe(true);
    expect(matches(occurrence, needsHumanWhere(new Date()))).toBe(true);
  });

  it("keeps its booking from completing and its earning from releasing", () => {
    const appointment = { occurrences: [occurrence] };
    expect(
      matches(appointment, { occurrences: { none: AWAITING_HUMAN } }),
    ).toBe(false);
    const payment = { refunds: [], appointmentId: "a1", appointment };
    expect(matches(payment, RELEASABLE_PAYMENT)).toBe(false);
  });
});

it.each([
  ["a soft-deleted SUCCEEDED payment", "SUCCEEDED", new Date()],
  ["a FAILED payment", "FAILED", null],
  ["a PENDING payment", "PENDING", null],
  ["an EXPIRED payment", "EXPIRED", null],
])("%s does not hold a no-join session", (_label, paymentStatus, deletedAt) => {
  for (const outcome of ["NOBODY_JOINED", "OFFLINE"]) {
    const payment = [{ paymentStatus, deletedAt }];
    expect(matches(slot(outcome, payment), AWAITING_HUMAN)).toBe(false);
  }
});

it("a free session nobody joined moves no money, so it does not wait for ops", () => {
  expect(matches(slot("NOBODY_JOINED", []), AWAITING_HUMAN)).toBe(false);
});
