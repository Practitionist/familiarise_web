/**
 * A dead hold frees its time by predicate, before any sweep.
 *
 * The JS predicate (allocator, /validate) and its SQL twin (the grid, checkout
 * step 1, the trial route) must agree on the two dead shapes: a hold whose
 * every payment is dead, and an unanswered request past the hold window the
 * request caps count by. A zero-payment appointment, a request inside its
 * window and a booking being moved keep blocking. The rest of the file pins
 * the lock-budget and lock-name decisions as source assertions, because a
 * regression there is a 504 under contention, which no unit test can observe.
 */

import "./setup";

// needs-you is read for BEING_MOVED and the cap count only; its client and
// payout reads never run here.
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/data/consultant-payout-setup", () => ({
  __esModule: true,
  readPayoutRequirements: jest.fn(),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BEING_MOVED_COUNTS,
  buildDeadHoldFilter,
} from "../../utils/scheduling-engine/occupancyPolicy";
import { BEING_MOVED } from "../../lib/data/needs-you";
import { countActiveConsultationRequests } from "../../lib/booking/request-caps";
import { isOccupiedByLiveAppointment } from "../../utils/scheduling-engine/ScheduleValidationService";

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
    ["a FAILED payment", [{ paymentStatus: "FAILED" }], false],
    [
      "a PENDING payment past expiresAt",
      [{ paymentStatus: "PENDING", expiresAt: PAST }],
      false,
    ],
    [
      "one payment still live",
      [
        { paymentStatus: "PENDING", expiresAt: PAST },
        { paymentStatus: "PENDING", expiresAt: FUTURE },
      ],
      true,
    ],
    [
      "a SUCCEEDED payment past expiresAt (confirmation not landed yet)",
      [{ paymentStatus: "SUCCEEDED", expiresAt: PAST }],
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

  it("a request inside its hold window waits on a human, never on a payment", () => {
    expect(
      isOccupiedByLiveAppointment(
        {
          subscription: {
            ...pending("REQUEST_SUBMITTED"),
            requestedAt: hoursAgo(47),
          },
          payment: [{ paymentStatus: "EXPIRED" }] as never,
          _count: NOT_MOVING,
        },
        NOW,
      ),
    ).toBe(true);
  });
});

const HOUR_MS = 60 * 60 * 1000;
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * HOUR_MS);
const NOT_MOVING = { rescheduleRequests: 0, occurrences: 0 };

describe("an unanswered request stops holding at the caps' clock", () => {
  const request = (hours: number) => ({
    status: "PENDING" as const,
    bookingSource: "REQUEST_SUBMITTED" as const,
    requestedAt: hoursAgo(hours),
  });
  const capWhere = async () => {
    const count = jest.fn().mockResolvedValue(0);
    await countActiveConsultationRequests(
      { consultation: { count } },
      "consultee-1",
      NOW,
    );
    return count.mock.calls[0][0].where;
  };
  const requestArm = (kind: "consultation" | "subscription") => {
    const arms = (buildDeadHoldFilter(NOW).OR ?? []) as Array<
      Record<string, { requestedAt?: { lt: Date } } | undefined>
    >;
    const arm = arms.find((a) => a[kind]?.requestedAt);
    if (!arm) throw new Error(`no ${kind} request arm`);
    return arm;
  };

  it("a 49-hour-old request is free for the cap count and for occupancy", async () => {
    const where = await capWhere();
    expect(hoursAgo(49).getTime()).toBeLessThan(
      where.requestedAt.gte.getTime(),
    );
    expect(
      isOccupiedByLiveAppointment(
        { consultation: request(49), payment: [], _count: NOT_MOVING },
        NOW,
      ),
    ).toBe(false);
  });

  it("a 47-hour-old request holds for both", async () => {
    const where = await capWhere();
    expect(hoursAgo(47).getTime()).toBeGreaterThanOrEqual(
      where.requestedAt.gte.getTime(),
    );
    expect(
      isOccupiedByLiveAppointment(
        { consultation: request(47), payment: [], _count: NOT_MOVING },
        NOW,
      ),
    ).toBe(true);
  });

  it.each([
    ["an open move", { rescheduleRequests: 1, occurrences: 0 }],
    ["a released session", { rescheduleRequests: 0, occurrences: 1 }],
    ["its move facts not read", undefined],
  ])("a 49-hour-old PENDING booking with %s still holds", (_, counts) => {
    expect(
      isOccupiedByLiveAppointment(
        { consultation: request(49), payment: [], _count: counts },
        NOW,
      ),
    ).toBe(true);
  });

  it("a plan request holds for its own 30-day window", () => {
    const at = (hours: number) =>
      isOccupiedByLiveAppointment(
        { subscription: request(hours), payment: [], _count: NOT_MOVING },
        NOW,
      );
    expect(at(29 * 24)).toBe(true);
    expect(at(31 * 24)).toBe(false);
  });

  it("a direct checkout never lapses by the request clock", () => {
    expect(
      isOccupiedByLiveAppointment(
        {
          consultation: { ...request(49), bookingSource: "DIRECT_CHECKOUT" },
          payment: [],
          _count: NOT_MOVING,
        },
        NOW,
      ),
    ).toBe(true);
  });

  it("the SQL twin cuts at the cap count's instant and spares a booking being moved", async () => {
    const where = await capWhere();
    const consultation = requestArm("consultation");
    expect(consultation).toEqual({
      consultation: {
        status: "PENDING",
        bookingSource: "REQUEST_SUBMITTED",
        requestedAt: { lt: where.requestedAt.gte },
      },
      NOT: BEING_MOVED,
    });
    expect(where.NOT).toEqual({ appointment: BEING_MOVED });
    expect(requestArm("subscription")).toEqual({
      subscription: {
        status: "PENDING",
        bookingSource: "REQUEST_SUBMITTED",
        requestedAt: { lt: new Date(NOW.getTime() - 30 * 24 * HOUR_MS) },
      },
      NOT: BEING_MOVED,
    });
  });

  it("the JS twin counts the same two things BEING_MOVED matches", () => {
    expect(BEING_MOVED.OR).toEqual([
      {
        rescheduleRequests: {
          some: BEING_MOVED_COUNTS.select.rescheduleRequests.where,
        },
      },
      { occurrences: { some: BEING_MOVED_COUNTS.select.occurrences.where } },
    ]);
  });
});

describe("buildDeadHoldFilter — the SQL twin", () => {
  it("a payment arm requires at least one payment row (every() is vacuous on none) and names both dead shapes", () => {
    const filter = buildDeadHoldFilter(NOW);
    const arms = ((filter.OR ?? []) as Array<Record<string, unknown>>).filter(
      (arm) => arm.payment,
    );
    expect(arms).toHaveLength(4);
    for (const arm of arms) {
      const payment = arm.payment as {
        some: unknown;
        every: { OR: unknown[] };
      };
      expect(payment.some).toEqual({});
      expect(payment.every.OR).toEqual(
        expect.arrayContaining([
          { paymentStatus: "EXPIRED" },
          { paymentStatus: "FAILED" },
          { paymentStatus: "PENDING", expiresAt: { lt: NOW } },
        ]),
      );
      // The clock alone never kills a row.
      expect(payment.every.OR).not.toContainEqual({ expiresAt: { lt: NOW } });
      expect(JSON.stringify(arm)).not.toContain("REQUEST_SUBMITTED");
    }
    expect(JSON.stringify(arms)).toContain('"bookingSource":"DIRECT_CHECKOUT"');
  });

  it("frees nothing beyond the payment arms and the two request arms", () => {
    expect(buildDeadHoldFilter(NOW).OR).toHaveLength(6);
  });
});

describe("lock budgets and names (source pins)", () => {
  it("request paths use the bounded retry config, not the 204 s default", () => {
    // Source pins, not imports: the lock module loads @upstash/redis, whose
    // ESM build jest cannot parse without a transform the suites don't carry.
    const src = read("utils/appointmentlock.ts");
    expect(src).toMatch(/APPROVAL_LOCK_TTL_MS = 45_?000/);
    expect(src).toMatch(
      /REQUEST_PATH_RETRY_CONFIG: LockRetryConfig = \{[\s\S]{0,200}?retryCount: [1-5],/,
    );
    expect(src).not.toMatch(/export (async )?function isAppointmentLocked/);
  });

  it("the pay-link mint is its own guarded atom, nested under the approval lock", () => {
    // The approval routes mint while holding consultation-approval:<id>, so
    // the mint must NOT take that key (it would contend with its caller).
    const src = read("lib/payments/operations/approval-payment.ts");
    expect(src).toMatch(/lockApprovalPaymentMint\(/);
    expect(src).not.toMatch(
      /lockConsultationApproval\(|lockSubscriptionApproval\(/,
    );
    expect(src).not.toMatch(/from "@\/lib\/redis"/);
    const locks = read("utils/appointmentlock.ts");
    expect(locks).toContain(
      "approval-payment-mint:${kind.toLowerCase()}:${id}",
    );
  });

  it("checkout renews the slot grant inside every Serializable attempt", () => {
    const src = read("lib/payments/checkout/commit/index.ts");
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
      expect(src).toMatch(/withAppointmentLock\(appointmentId, \(lock\) =>/);
    }
  });
});
