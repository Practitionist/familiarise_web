/**
 * @jest-environment node
 */

/**
 * The grid's ETag must move when a PENDING hold lapses by the clock alone (no
 * row written), when a cell enters the booking lead time, and when the
 * consultant is soft-deleted, or pollers keep a stale grid through 304s.
 */

import {
  availabilityGridEtag,
  leadTimeBucket,
  readAvailabilityGridMarker,
  subscriptionQuotaFold,
  type AvailabilityGridEtagKey,
  type AvailabilityGridMarker,
} from "@/lib/scheduling/availabilityGridMarker";
import type { Db } from "@/lib/prisma";

const MINUTE = 60 * 1000;

const marker = (
  overrides: Partial<AvailabilityGridMarker> = {},
): AvailabilityGridMarker => ({
  profileUpdatedAt: new Date("2026-09-01T10:00:00.000Z"),
  consultantDeletedAt: null,
  availabilityUpdatedAt: new Date("2026-09-01T11:00:00.000Z"),
  availabilityRowCount: 3,
  paymentsUpdatedAt: new Date("2026-09-06T09:00:00.000Z"),
  slotsUpdatedAt: new Date("2026-09-06T09:00:00.000Z"),
  slotRowCount: 2,
  collaboratorsUpdatedAt: null,
  requestsUpdatedAt: new Date("2026-09-06T09:00:00.000Z"),
  nextHoldExpiry: null,
  ...overrides,
});

const key = (
  overrides: Partial<AvailabilityGridEtagKey> = {},
): AvailabilityGridEtagKey => ({
  consultantId: "cp-1",
  startIso: "2026-09-07T00:00:00.000Z",
  endIso: "2026-09-14T00:00:00.000Z",
  timezone: "Asia/Kolkata",
  includeAppointmentDetails: false,
  consulteeUserId: "user-consultee",
  leadBucket: 1000,
  ...overrides,
});

describe("availabilityGridEtag clock folds", () => {
  it("changes when the earliest live hold lapses with no row written", () => {
    // Two PENDING holds; the marker carries the earliest still-future deadline.
    const firstHold = new Date("2026-09-07T10:30:00.000Z");
    const secondHold = new Date("2026-09-07T11:00:00.000Z");
    const before = availabilityGridEtag(
      marker({ nextHoldExpiry: firstHold }),
      key(),
    );
    // After 10:30 the first hold drops out of `expiresAt > now()`; every
    // timestamp and count is unchanged.
    const afterFirst = availabilityGridEtag(
      marker({ nextHoldExpiry: secondHold }),
      key(),
    );
    const afterBoth = availabilityGridEtag(
      marker({ nextHoldExpiry: null }),
      key(),
    );
    expect(afterFirst).not.toBe(before);
    expect(afterBoth).not.toBe(afterFirst);
    expect(
      availabilityGridEtag(marker({ nextHoldExpiry: firstHold }), key()),
    ).toBe(before);
  });

  it("changes when a cell crosses into the lead time", () => {
    // 09:44 + 15 min = 09:59 → bucket ends 10:00; 09:46 + 15 = 10:01 → next.
    const at0944 = Date.parse("2026-09-07T09:44:00.000Z");
    const at0946 = at0944 + 2 * MINUTE;
    const at0950 = at0944 + 6 * MINUTE;
    expect(leadTimeBucket(at0946)).toBe(leadTimeBucket(at0944) + 1);
    expect(leadTimeBucket(at0950)).toBe(leadTimeBucket(at0946));
    expect(
      availabilityGridEtag(
        marker(),
        key({ leadBucket: leadTimeBucket(at0944) }),
      ),
    ).not.toBe(
      availabilityGridEtag(
        marker(),
        key({ leadBucket: leadTimeBucket(at0946) }),
      ),
    );
  });

  it("changes when the consultant is soft-deleted", () => {
    expect(
      availabilityGridEtag(
        marker({ consultantDeletedAt: new Date("2026-09-07T08:00:00.000Z") }),
        key(),
      ),
    ).not.toBe(availabilityGridEtag(marker(), key()));
  });

  it("changes when the subscription's occurrences move outside the window", () => {
    const base = {
      subscriptionId: "sub-1",
      subscriptionUpdatedAt: new Date("2026-09-01T00:00:00.000Z"),
      occurrenceCount: 1,
      occurrencesUpdatedAt: new Date("2026-09-02T00:00:00.000Z"),
      todayKey: "2026-09-07",
    };
    const fold = subscriptionQuotaFold(base);
    for (const changed of [
      { ...base, occurrencesUpdatedAt: new Date("2026-09-03T00:00:00.000Z") },
      { ...base, occurrenceCount: 2 },
      { ...base, releasingIds: ["occ-1"] },
      { ...base, todayKey: "2026-09-08" },
      { ...base, subscriptionUpdatedAt: new Date("2026-09-04T00:00:00.000Z") },
    ]) {
      expect(subscriptionQuotaFold(changed)).not.toBe(fold);
    }
    expect(availabilityGridEtag(marker(), key({ quotaFold: fold }))).not.toBe(
      availabilityGridEtag(marker(), key()),
    );
  });
});

describe("readAvailabilityGridMarker SQL shape", () => {
  async function capturedSql(): Promise<{ sql: string; values: unknown[] }> {
    let sql = "";
    let values: unknown[] = [];
    const db = {
      $queryRaw: async (strings: TemplateStringsArray, ...args: unknown[]) => {
        sql = strings.join("$?");
        values = args;
        return [];
      },
    } as unknown as Db;
    await readAvailabilityGridMarker(
      db,
      "cp-1",
      "user-consultee",
      {
        startsAt: new Date("2026-09-07T00:00:00.000Z"),
        endsAt: new Date("2026-09-14T00:00:00.000Z"),
      },
      { webinarId: "web-1" },
    );
    return { sql: sql.replace(/\s+/g, " "), values };
  }

  it("folds the earliest still-future PENDING deadline over every reached appointment", async () => {
    const { sql, values } = await capturedSql();
    const hold = sql.slice(sql.indexOf('min(p."expiresAt")'));
    expect(hold).toMatch(
      /^min\(p\."expiresAt"\) FROM "Payment" p JOIN reach r ON r\.id = p\."appointmentId" WHERE p\."paymentStatus" = 'PENDING' AND p\."expiresAt" > now\(\)\) AS "nextHoldExpiry"/,
    );
    // `reach` spans the consultant, consultee and co-host arms, in the window.
    expect(sql).toContain('WHERE p."userId" = $?');
    expect(values).toContain("user-consultee");
    expect(sql).toContain(
      'JOIN "Collaborator" cb ON cb."webinarPlanId" = w."webinarPlanId"',
    );
    expect(sql).toMatch(
      /reach AS \( SELECT k\.id FROM candidates k WHERE EXISTS/,
    );
  });

  it("reads the consultant's tombstone", async () => {
    const { sql } = await capturedSql();
    expect(sql).toContain('AS "consultantDeletedAt"');
  });
});
