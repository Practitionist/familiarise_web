/**
 * The allocator re-reads published availability inside its write transaction:
 * a shrink that committed after the search refuses with AVAILABILITY_CHANGED
 * instead of booking into the removed hours.
 */
import "./setup";

import { assertSlotsStillPublished } from "@/lib/booking/allocation/coverage";
import type { Tx } from "@/lib/prisma";

const MONDAY_10_UTC = new Date("2031-03-03T10:00:00.000Z");
const halfHour = (d: Date, n = 1) => new Date(d.getTime() + n * 30 * 60_000);

function txWithCustomRows(rows: { startsAt: Date; endsAt: Date }[]): Tx {
  return {
    consultantProfile: {
      findUnique: async () => ({ scheduleType: "CUSTOM", deletedAt: null }),
    },
    availabilityWindowWeekly: { findMany: async () => [] },
    availabilityWindowCustom: { findMany: async () => rows },
  } as unknown as Tx;
}

it("passes while every chosen interval is still published", async () => {
  const tx = txWithCustomRows([
    { startsAt: MONDAY_10_UTC, endsAt: halfHour(MONDAY_10_UTC, 2) },
  ]);
  await expect(
    assertSlotsStillPublished(tx, "cp-1", [
      MONDAY_10_UTC,
      halfHour(MONDAY_10_UTC),
    ]),
  ).resolves.toBeUndefined();
});

it("refuses with AVAILABILITY_CHANGED once an interval was removed", async () => {
  const tx = txWithCustomRows([
    { startsAt: MONDAY_10_UTC, endsAt: halfHour(MONDAY_10_UTC) },
  ]);
  await expect(
    assertSlotsStillPublished(tx, "cp-1", [
      MONDAY_10_UTC,
      halfHour(MONDAY_10_UTC),
    ]),
  ).rejects.toMatchObject({
    errorCode: "AVAILABILITY_CHANGED",
    httpStatus: 409,
  });
});
