/**
 * Keyset continuation at the column's microseconds: rows created inside one
 * millisecond, with ids ordered against their timestamps, continue in exactly
 * the order ORDER BY gave them, in both directions.
 */
import { randomUUID } from "node:crypto";

import prisma from "../../lib/prisma";
import { readConsultantAppointmentsPage } from "../../lib/data/consultant-appointments";
import { readRequestsInbox } from "../../lib/data/requests-inbox";
import { encodeInboxCursor } from "../../lib/dashboard/requests-inbox-state";
import { HOUR_MS, seedConsultee, seedHost } from "./booking/harness";

const MS = "2025-01-06T10:00:00.000";
/** Exact keys, oldest first: inside one millisecond the ids run backwards. */
const STAMPS = [
  { prefix: "m", at: "2025-01-06T09:59:59.999500Z" },
  { prefix: "z", at: `${MS}100Z` },
  { prefix: "q", at: `${MS}500Z` },
  { prefix: "a", at: `${MS}900Z` },
  { prefix: "b", at: "2025-01-06T10:00:00.001200Z" },
];

async function stamp(
  table: "Appointment" | "Consultation",
  id: string,
  at: string,
) {
  const column = table === "Appointment" ? "createdAt" : "requestedAt";
  await prisma.$executeRawUnsafe(
    `UPDATE "${table}" SET "${column}" = $1::timestamptz WHERE id = $2`,
    at,
    id,
  );
}

async function seedRequests() {
  const host = await seedHost();
  const plan = await prisma.consultationPlan.create({
    data: {
      title: "Keyset consultation",
      price: BigInt(100_000),
      consultantProfileId: host.consultantProfileId,
    },
  });
  const suffix = randomUUID();
  const ids: string[] = [];
  for (const { prefix, at } of STAMPS) {
    const consultee = await seedConsultee();
    const id = `${prefix}-${suffix}`;
    await prisma.consultation.create({
      data: {
        id,
        consultationPlanId: plan.id,
        requestedById: consultee.consulteeProfileId,
        status: "REJECTED",
        bookingSource: "REQUEST_SUBMITTED",
      },
    });
    await stamp("Consultation", id, at);
    ids.push(id);
  }
  return { host, plan, ids };
}

describe("consultant appointments: Load older continues at microseconds", () => {
  it("returns every older row after a cursor inside a shared millisecond", async () => {
    const { host, ids: consultationIds } = await seedRequests();
    const suffix = randomUUID();
    const appointmentIds: string[] = [];
    for (const [i, { prefix, at }] of STAMPS.entries()) {
      const id = `${prefix}-${suffix}`;
      await prisma.appointment.create({
        data: {
          id,
          appointmentType: "CONSULTATION",
          consultationId: consultationIds[i],
        },
      });
      // Every session has ended, so each row is a past row.
      const startsAt = new Date(Date.UTC(2025, 0, 1, i * 2));
      await prisma.appointmentOccurrence.create({
        data: {
          appointmentId: id,
          ordinal: 1,
          startsAt,
          endsAt: new Date(startsAt.getTime() + HOUR_MS),
          isTentative: false,
          consultantProfileId: host.consultantProfileId,
          completionStatus: "COMPLETED",
        },
      });
      await stamp("Appointment", id, at);
      appointmentIds.push(id);
    }
    const [m, z, q, a] = appointmentIds;
    const cursorRow = await prisma.appointment.findUniqueOrThrow({
      where: { id: a },
      select: { id: true, createdAt: true },
    });

    const page = await readConsultantAppointmentsPage({
      consultantProfileId: host.consultantProfileId,
      scope: { kind: "personal" },
      window: "older",
      before: cursorRow,
    });

    // Newest first: a(.000900) → q(.000500) → z(.000100) → m(previous ms).
    expect(page.rows.map((r) => r.id).sort()).toEqual([m, q, z].sort());
  });
});

describe("requests inbox: one source pages at microseconds", () => {
  async function walk(cp: string, sort: "old" | "new"): Promise<string[]> {
    const seen: string[] = [];
    let after: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page = await readRequestsInbox({
        consultantProfileId: cp,
        type: "consultation",
        chip: "declined",
        sort,
        page: 1,
        after,
        limit: 1,
      });
      expect(page.meta.paging).toBe("cursor");
      seen.push(...page.rows.map((r) => r.id));
      after = page.meta.nextCursor;
      if (!after) break;
    }
    return seen;
  }

  it("walks oldest first in exact key order, one row a page", async () => {
    const { host, ids } = await seedRequests();
    expect(await walk(host.consultantProfileId, "old")).toEqual(ids);
  });

  it("walks newest first in exact key order, one row a page", async () => {
    const { host, ids } = await seedRequests();
    expect(await walk(host.consultantProfileId, "new")).toEqual(
      [...ids].reverse(),
    );
  });

  it("continues past a cursor whose millisecond holds rows on both sides", async () => {
    const { host, ids } = await seedRequests();
    const [, z, q, a, b] = ids;
    const cursorRow = await prisma.consultation.findUniqueOrThrow({
      where: { id: q },
      select: { id: true, requestedAt: true },
    });
    const page = await readRequestsInbox({
      consultantProfileId: host.consultantProfileId,
      type: "consultation",
      chip: "declined",
      sort: "old",
      page: 1,
      after: encodeInboxCursor(cursorRow),
      limit: 10,
    });
    expect(page.rows.map((r) => r.id)).toEqual([a, b]);
    expect(page.rows.map((r) => r.id)).not.toContain(z);
  });

  it("a time sort over several sources pages a window, never a cursor", async () => {
    const { host } = await seedRequests();
    const page = await readRequestsInbox({
      consultantProfileId: host.consultantProfileId,
      type: "consultation",
      sort: "new",
      page: 1,
      after: null,
    });
    expect(page.meta.paging).toBe("ranked");
    expect(page.meta.nextCursor).toBeNull();
  });
});
