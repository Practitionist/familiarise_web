/**
 * Sold group events on the database: a class with a live buyer seat refuses a
 * re-plan inside the allocator's transaction (the host's own participant row
 * never counts as a sale), and the series re-time moves every session at least
 * 24 hours away in place, keeps nearer ones, opens the free leave and records
 * no miss.
 */
import prisma from "../../../lib/prisma";
import { seedHost } from "./harness";
import {
  CLASS_UNDER_WAY,
  seatClassBuyer,
  seedClassUnderWay,
} from "./harness-class-series";

jest.mock("../../../lib/novu/service", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});

import { assertGroupEventUnsoldInTx } from "../../../lib/booking/allocation/guards";
import { readHostedClass } from "../../../lib/booking/class-sessions";
import { retimeClassSeries } from "../../../lib/booking/class-retime";
import { AllocationConflictError } from "../../../utils/scheduling-engine/errors";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A UTC half-hour instant `days` from now at `hour`:00 UTC. */
function onGrid(days: number, hour: number): Date {
  const d = new Date(Date.now() + days * DAY_MS);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

describe("sold group events", () => {
  it("lets an unsold class (host row only) be re-planned and refuses one with a buyer", async () => {
    const host = await seedHost();
    const cls = await seedClassUnderWay(host, CLASS_UNDER_WAY);
    await expect(
      prisma.$transaction((tx) =>
        assertGroupEventUnsoldInTx(tx, "class", cls.classId),
      ),
    ).resolves.toBeUndefined();

    await seatClassBuyer(cls, CLASS_UNDER_WAY);
    const refusal = prisma.$transaction((tx) =>
      assertGroupEventUnsoldInTx(tx, "class", cls.classId),
    );
    await expect(refusal).rejects.toBeInstanceOf(AllocationConflictError);
    await expect(refusal).rejects.toMatchObject({ errorCode: "USE_RETIME" });
  });

  it("moves every session 24 h or more away in place and opens the free leave", async () => {
    const host = await seedHost();
    const cls = await seedClassUnderWay(host, CLASS_UNDER_WAY);
    await seatClassBuyer(cls, CLASS_UNDER_WAY);
    const hosted = await readHostedClass(cls.appointmentId);
    if (!hosted.found) throw new Error("class not seeded");

    const before = await prisma.appointmentOccurrence.findMany({
      where: {
        appointmentId: cls.appointmentId,
        completionStatus: "SCHEDULED",
      },
      orderBy: { startsAt: "asc" },
    });
    // Seven upcoming sessions, two days out and later: all are movable.
    const starts = before.map((_, i) => onGrid(5 + i * 2, 7));
    const result = await retimeClassSeries({
      hosted,
      starts,
      actorUserId: host.userId,
    });
    expect(result.moved).toBe(before.length);

    const after = await prisma.appointmentOccurrence.findMany({
      where: {
        appointmentId: cls.appointmentId,
        completionStatus: "SCHEDULED",
      },
      orderBy: { startsAt: "asc" },
    });
    expect(after.map((o) => o.id)).toEqual(before.map((o) => o.id));
    expect(after.map((o) => o.startsAt)).toEqual(starts);
    expect(after.every((o) => o.movedAt !== null && !o.isTentative)).toBe(true);
    expect(after.map((o) => o.ordinal)).toEqual(before.map((o) => o.ordinal));

    const event = await prisma.class.findUniqueOrThrow({
      where: { id: cls.classId },
      select: { retimeBy: true },
    });
    expect(event.retimeBy).not.toBeNull();
    // A move is not a cancel: nothing is marked host-cancelled.
    const cancelled = await prisma.appointmentOccurrence.count({
      where: {
        appointmentId: cls.appointmentId,
        hostCancelledAt: { not: null },
      },
    });
    expect(cancelled).toBe(0);
  });

  it("refuses the wrong number of new times without moving anything", async () => {
    const host = await seedHost();
    const cls = await seedClassUnderWay(host, CLASS_UNDER_WAY);
    const hosted = await readHostedClass(cls.appointmentId);
    if (!hosted.found) throw new Error("class not seeded");
    await expect(
      retimeClassSeries({
        hosted,
        starts: [onGrid(5, 7)],
        actorUserId: host.userId,
      }),
    ).rejects.toMatchObject({ code: "RETIME_NOT_ALLOWED" });
    const moved = await prisma.appointmentOccurrence.count({
      where: { appointmentId: cls.appointmentId, movedAt: { not: null } },
    });
    expect(moved).toBe(0);
  });
});
