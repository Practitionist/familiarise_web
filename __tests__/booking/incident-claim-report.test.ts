/**
 * @jest-environment node
 */

// Invariant: an incident reports each no-show claimed inside it once, and a page
// of claims already reported never hides one that is not.

jest.mock("../../lib/prisma", () => {
  const { memTable } = jest.requireActual("../fixtures/mem-db");
  return {
    __esModule: true,
    default: {
      appointmentOccurrence: memTable([], "occ"),
      systemEvent: memTable([], "ev"),
      $queryRaw: jest.fn(async () => []),
    },
  };
});

import prisma from "@/lib/prisma";
import { type memTable, type Row } from "../fixtures/mem-db";
import {
  hasUnreportedClaims,
  reportClaimedNoShows,
} from "@/lib/booking/platform-incidents";

type Table = ReturnType<typeof memTable>;
const occurrences = prisma.appointmentOccurrence as unknown as Table;
const events = prisma.systemEvent as unknown as Table;

const START = new Date("2026-11-20T10:00:00Z");
const END = new Date("2026-11-20T11:00:00Z");
const incident = { id: "inc-1", startsAt: START, endsAt: END };

const claimed = (id: string): Row => ({
  id,
  appointmentId: `apt-${id}`,
  startsAt: START,
  endsAt: END,
  isTentative: false,
  deletedAt: new Date("2026-11-23T10:00:00Z"),
  completionStatus: "CANCELLED",
  outcome: "HOST_ABSENT",
  outcomeConfirmedAt: new Date("2026-11-23T10:00:00Z"),
  appointment: { consultationId: `cons-${id}`, payment: [{ id: `pay-${id}` }] },
});

it("reports the 201st claim when the first 200 are already reported, and nothing on a replay", async () => {
  for (let i = 0; i < 201; i++) {
    const id = `occ-${String(i).padStart(3, "0")}`;
    occurrences.rows.push(claimed(id));
    if (i < 200)
      events.rows.push({
        id: `ev-${i}`,
        correlationId: `incident-no-show-claim:inc-1:${id}`,
      });
  }
  // Postgres honours order and take; the in-memory table does not.
  const read = occurrences.findMany.getMockImplementation()!;
  occurrences.findMany.mockImplementation(async (args) => {
    const rows = (await read(args)) as Row[];
    const take = (args as unknown as { take?: number }).take;
    const ordered = [...rows].sort((a, b) =>
      String(a.id).localeCompare(String(b.id), "en"),
    );
    return take ? ordered.slice(0, take) : ordered;
  });

  expect(await reportClaimedNoShows(incident)).toEqual(["occ-200"]);
  const item = events.rows.find(
    (e) => e.correlationId === "incident-no-show-claim:inc-1:occ-200",
  );
  // It names the claim and asks ops to check the refund; it does not say the refund went.
  expect(item?.message).toMatch(
    /was claimed inside incident inc-1; check its refund/,
  );
  expect(await reportClaimedNoShows(incident)).toEqual([]);
});

it("the idle probe answers work without a statement once it is out of time, and none when the read finds nothing", async () => {
  const queryRaw = prisma.$queryRaw as unknown as jest.Mock;
  queryRaw.mockClear();
  expect(await hasUnreportedClaims(prisma, START, () => true)).toBe(true);
  expect(queryRaw).not.toHaveBeenCalled();
  expect(await hasUnreportedClaims(prisma, START, () => false)).toBe(false);
  expect(queryRaw).toHaveBeenCalledTimes(1);
});
