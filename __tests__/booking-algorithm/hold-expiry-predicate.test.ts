/**
 * #1319 PR 3 — a lapsed direct-checkout hold frees its slot by predicate.
 *
 * The JS predicate (grid, allocator, /validate) and its SQL twin (checkout
 * step 1, the trial route) must agree, and the two must free ONLY the
 * direct-checkout hold: zero-payment appointments and REQUEST_SUBMITTED
 * requests keep blocking. The rest of the file pins the lock-budget and
 * lock-name decisions as source assertions, because a regression there is a
 * 504 under contention, which no unit test can observe.
 */

import "./setup";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDeadHoldFilter } from "../../utils/slotAllocation/occupancyPolicy";
import { isOccupiedByLiveAppointment } from "../../utils/slotAllocation/SlotValidationService";

const NOW = new Date("2026-09-02T10:00:00Z");
const PAST = new Date("2026-09-02T09:00:00Z");
const FUTURE = new Date("2026-09-02T11:00:00Z");
const read = (rel: string) =>
  readFileSync(join(__dirname, "../../", rel), "utf8");

describe("isOccupiedByLiveAppointment — direct-checkout hold expiry", () => {
  const pending = (bookingSource: "DIRECT_CHECKOUT" | "REQUEST_SUBMITTED") => ({
    status: "PENDING" as const,
    bookingSource,
  });

  it.each([
    ["all payments EXPIRED", [{ paymentStatus: "EXPIRED" }], false],
    ["all payments past expiresAt", [{ expiresAt: PAST }], false],
    [
      "one payment still live",
      [{ expiresAt: PAST }, { expiresAt: FUTURE }],
      true,
    ],
    ["zero payment rows", [], true],
  ])(
    "DIRECT_CHECKOUT PENDING with %s → occupied=%s",
    (_, payment, expected) => {
      expect(
        isOccupiedByLiveAppointment(
          {
            consultation: pending("DIRECT_CHECKOUT"),
            payment: payment as never,
          },
          NOW,
        ),
      ).toBe(expected);
    },
  );

  it("REQUEST_SUBMITTED PENDING waits on a human, never on a payment", () => {
    expect(
      isOccupiedByLiveAppointment(
        {
          subscription: pending("REQUEST_SUBMITTED"),
          payment: [{ paymentStatus: "EXPIRED" }] as never,
        },
        NOW,
      ),
    ).toBe(true);
  });
});

describe("buildDeadHoldFilter — the SQL twin", () => {
  it("requires at least one payment row (every() is vacuous on none) and names both dead shapes", () => {
    const filter = buildDeadHoldFilter(NOW);
    const arms = (filter.OR ?? []) as Array<Record<string, unknown>>;
    expect(arms.length).toBeGreaterThanOrEqual(4);
    for (const arm of arms) {
      const payment = arm.payment as {
        some: unknown;
        every: { OR: unknown[] };
      };
      expect(payment.some).toEqual({});
      expect(payment.every.OR).toEqual(
        expect.arrayContaining([
          { paymentStatus: "EXPIRED" },
          { expiresAt: { lt: NOW } },
        ]),
      );
    }
    const serialized = JSON.stringify(filter);
    expect(serialized).toContain('"bookingSource":"DIRECT_CHECKOUT"');
    expect(serialized).not.toContain("REQUEST_SUBMITTED");
  });
});

describe("lock budgets and names (source pins)", () => {
  it("request paths use the bounded retry config, not the 204 s default", () => {
    const src = read("utils/appointmentlock.ts");
    expect(src).toMatch(/REQUEST_PATH_RETRY_CONFIG/);
    expect(src).toMatch(/APPROVAL_LOCK_TTL_MS = 45_000/);
    expect(src).not.toMatch(/export (async )?function isAppointmentLocked/);
  });

  it("the approval-payment mint locks under the approval atoms, not a private name", () => {
    const src = read("lib/payments/operations/approval-payment.ts");
    expect(src).toMatch(/lockConsultationApproval\(/);
    expect(src).toMatch(/lockTrialApproval\(/);
    expect(src).not.toMatch(/from "@\/lib\/redis"/);
  });

  it("checkout renews the slot grant inside every Serializable attempt", () => {
    const src = read("lib/payments/operations/checkout.ts");
    expect(src).toMatch(
      /withSerializableRetry\(async \(\) => \{\s*await renewOrAbort\(perAttemptTtl\);/,
    );
  });

  it("cancel and reschedule take the appointment lock and the mutation limiter", () => {
    for (const rel of [
      "app/api/appointments/[appointmentId]/cancel/route.ts",
      "app/api/appointments/[appointmentId]/reschedule/route.ts",
    ]) {
      const src = read(rel);
      expect(src).toMatch(
        /applyRateLimit\(eventMutationLimiter, session\.user\.id\)/,
      );
      expect(src).toMatch(/withAppointmentLock\(appointmentId, \(\) =>/);
    }
  });
});
