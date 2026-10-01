/**
 * @jest-environment node
 */

/**
 * The admin refund doors' key contract.
 *
 * Both doors used to derive their `Refund.dedupeKey` as
 * `ops:${body.idempotencyKey ?? opsActionId}`. `opsActionId` is a per-request
 * `randomUUID()`, so a caller that omitted the key got a FRESH dedupeKey on
 * every click. `Refund.dedupeKey` is `@unique`, but a value that is unique by
 * construction never trips it: the constraint was inert, the in-transaction
 * refundable-balance re-derivation still saw the full balance, and one
 * double-click issued two real refunds.
 *
 * The invariant these pin: the key is REQUIRED, and the dedupeKey is a pure
 * function of it — so the existing `@unique` column is what collapses a repeat.
 * The collapse itself is enforced in `refundBookingPayment`'s `withDedupe`
 * (covered by booking-refund-rails); what these assert is that the route hands
 * that layer a byte-identical key on the second click instead of a fresh one.
 */

import { readFileSync } from "fs";
import path from "path";

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async () => ({
    session: { user: { id: "admin_1", role: "ADMIN" } },
  })),
}));
jest.mock("../../lib/backoffice/money-limit", () => ({
  assertMoneyOpsBudget: jest.fn(),
}));
const create = jest.fn(async (_a: unknown) => ({ id: "row" }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { opsActionLog: { create: (a: unknown) => create(a) } },
}));
// Rest-typed so the `jest.mock` facades below can forward a `unknown[]`
// spread into them (TS2556 otherwise: a spread argument must have a tuple
// type or be passed to a rest parameter).
const refundBookingPayment = jest.fn(async (..._args: unknown[]) => ({}));
const restoreClassSeatCredits = jest.fn(async (..._args: unknown[]) => ({
  restoredPaise: 0,
}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (...a: unknown[]) => refundBookingPayment(...a),
  restoreClassSeatCredits: (...a: unknown[]) => restoreClassSeatCredits(...a),
  fundingRailForIntent: jest.fn(),
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  RefundGatewayError: class extends Error {},
  RefundValidationError: class extends Error {},
  findDedupedRefund: async () => null,
}));

import { NextRequest } from "next/server";
import { POST as postIssue } from "../../app/api/admin/refunds/issue/route";
import { POST as postCredits } from "../../app/api/admin/refunds/credits/route";

/** A real v4 UUID — the shape the schema's `.uuid()` accepts. */
const KEY = "11111111-2222-4333-8444-555555555555";
const OTHER_KEY = "99999999-2222-4333-8444-555555555555";
const REASON = "goodwill for a late start";

function request(url: string, body: Record<string, unknown>) {
  return new NextRequest(`https://x.test${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const issue = (extra: Record<string, unknown>) =>
  postIssue(
    request("/api/admin/refunds/issue", {
      paymentId: "pay_1",
      amountPaise: 100,
      reason: REASON,
      ...extra,
    }),
    { params: Promise.resolve({}) },
  );

const credits = (extra: Record<string, unknown>) =>
  postCredits(
    request("/api/admin/refunds/credits", {
      paymentId: "pay_1",
      sessions: 3,
      reason: REASON,
      ...extra,
    }),
    { params: Promise.resolve({}) },
  );

const dedupeOf = (mock: jest.Mock, call = 0) =>
  (mock.mock.calls[call]?.[0] as { dedupeKey: string }).dedupeKey;

beforeEach(() => {
  refundBookingPayment.mockClear();
  restoreClassSeatCredits.mockClear();
  create.mockClear();
});

describe("a missing idempotency key is refused, never defaulted", () => {
  it("the issue door 400s and moves no money", async () => {
    const res = await issue({});

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; code: string };
    expect(json.code).toBe("INVALID_BODY");
    // Actionable: names the field the caller has to send.
    expect(json.error).toContain("idempotencyKey");
    expect(json.error).toContain("UUID");
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });

  it("the credits door 400s and restores nothing", async () => {
    const res = await credits({});

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; code: string };
    expect(json.code).toBe("INVALID_BODY");
    expect(json.error).toContain("idempotencyKey");
    expect(json.error).toContain("UUID");
    expect(restoreClassSeatCredits).not.toHaveBeenCalled();
  });

  it("the issue door also refuses a non-UUID key", async () => {
    const res = await issue({ idempotencyKey: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "idempotencyKey",
    );
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });

  it("the credits door also refuses a non-UUID key", async () => {
    const res = await credits({ idempotencyKey: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "idempotencyKey",
    );
    expect(restoreClassSeatCredits).not.toHaveBeenCalled();
  });
});

describe("a repeated key yields a stable dedupeKey (the second click collapses)", () => {
  it("issue: both clicks key the same Refund row", async () => {
    const first = await issue({ idempotencyKey: KEY });
    const second = await issue({ idempotencyKey: KEY });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(refundBookingPayment).toHaveBeenCalledTimes(2);
    // Byte-identical, and derived from the key alone — this is the precondition
    // for `Refund.dedupeKey @unique` to answer the second click with the first.
    expect(dedupeOf(refundBookingPayment, 0)).toBe(`ops:${KEY}`);
    expect(dedupeOf(refundBookingPayment, 1)).toBe(
      dedupeOf(refundBookingPayment, 0),
    );
  });

  it("credits: both clicks key the same Refund row", async () => {
    const first = await credits({ idempotencyKey: KEY });
    const second = await credits({ idempotencyKey: KEY });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(restoreClassSeatCredits).toHaveBeenCalledTimes(2);
    expect(dedupeOf(restoreClassSeatCredits, 0)).toBe(`ops:credits:${KEY}`);
    expect(dedupeOf(restoreClassSeatCredits, 1)).toBe(
      dedupeOf(restoreClassSeatCredits, 0),
    );
  });

  it("a different key is a different refund, not a dedupe", async () => {
    await issue({ idempotencyKey: KEY });
    await issue({ idempotencyKey: OTHER_KEY });

    expect(dedupeOf(refundBookingPayment, 0)).not.toBe(
      dedupeOf(refundBookingPayment, 1),
    );
  });
});

describe("the two doors namespace their keys", () => {
  it("one key string on both doors cannot collide", async () => {
    await issue({ idempotencyKey: KEY });
    await credits({ idempotencyKey: KEY });

    const issueKey = dedupeOf(refundBookingPayment, 0);
    const creditsKey = dedupeOf(restoreClassSeatCredits, 0);

    expect(issueKey).not.toBe(creditsKey);
    // Safe because a validated UUID contains no colon, so the bare `ops:` slot
    // and the `credits:` slot are disjoint.
    expect(issueKey).not.toContain("credits:");
    expect(creditsKey.startsWith("ops:credits:")).toBe(true);
  });
});

describe("no per-request key generation survives in either door (source contract)", () => {
  /**
   * Assert against CODE, not prose: both routes carry a comment explaining the
   * defect, and that comment legitimately names the old fallback. Stripping
   * comments first keeps these assertions from passing or failing on wording.
   */
  const codeOf = (rel: string) =>
    readFileSync(path.join(process.cwd(), rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it.each([
    "app/api/admin/refunds/issue/route.ts",
    "app/api/admin/refunds/credits/route.ts",
  ])("%s cannot fall back to a fresh opsActionId", (rel) => {
    const src = codeOf(rel);

    // The defect, verbatim: a per-request UUID in the dedupeKey expression.
    expect(src).not.toContain("?? opsActionId");
    expect(src).not.toMatch(
      /idempotencyKey\s*:\s*z\.string\(\)\.uuid\(\)\s*\.optional/,
    );
    expect(src).not.toContain("randomUUID");
    // `opsActionId` is no longer destructured into the door at all.
    expect(src).not.toMatch(/\(\s*\{[^}]*\bopsActionId\b[^}]*\}\s*\)\s*=>/);
  });
});
