/**
 * @jest-environment node
 */

/** #1819 L-5 — a late joiner's seat hides recordings of the sessions before it. */

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { hiddenFromLateJoiner } from "@/lib/stream/late-join-recordings";

const joinedAt = new Date("2026-10-01T12:00:00Z");
const rec = (classId: string, startsAt: string) => ({
  meeting: {
    occurrence: { startsAt: new Date(startsAt), appointment: { classId } },
  },
});

it("hides an earlier session of the seat's batch, and nothing else", () => {
  const floors = new Map([["batch-2", joinedAt]]);
  expect(
    hiddenFromLateJoiner(rec("batch-2", "2026-09-24T12:00:00Z"), floors),
  ).toBe(true);
  expect(
    hiddenFromLateJoiner(rec("batch-2", "2026-10-08T12:00:00Z"), floors),
  ).toBe(false);
  // No floor: the listing lets late joiners watch, or the viewer joined another batch.
  expect(
    hiddenFromLateJoiner(rec("batch-1", "2026-09-24T12:00:00Z"), floors),
  ).toBe(false);
  expect(
    hiddenFromLateJoiner(rec("batch-2", "2026-09-24T12:00:00Z"), new Map()),
  ).toBe(false);
});
