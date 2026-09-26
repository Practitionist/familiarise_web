/**
 * @jest-environment node
 */

/** #1819 L-5 — a late joiner's seat hides recordings of the sessions before it. */

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { hiddenFromLateJoiner } from "@/lib/stream/late-join-recordings";

const joinedAt = new Date("2026-10-01T12:00:00Z");
const rec = (classId: string, startsAt: string) => ({
  meeting: {
    occurrence: {
      startsAt: new Date(startsAt),
      appointment: { classId, class: { classPlanId: "plan-1" } },
    },
  },
});
const access = (lateOnly: boolean) => ({
  floors: new Map([["batch-2", joinedAt]]),
  lateSeatBatches: lateOnly
    ? new Map([["plan-1", new Set(["batch-2"])]])
    : new Map<string, Set<string>>(),
});
const hidden = (classId: string, startsAt: string, lateOnly = true) =>
  hiddenFromLateJoiner(rec(classId, startsAt), access(lateOnly));

it("hides an earlier session of the seat's batch and, for a late-only viewer, other batches", () => {
  expect(hidden("batch-2", "2026-09-24T12:00:00Z")).toBe(true);
  expect(hidden("batch-2", "2026-10-08T12:00:00Z")).toBe(false);
  // #1834 — another batch of the same listing would leak the sessions not bought.
  expect(hidden("batch-1", "2026-09-24T12:00:00Z")).toBe(true);
  // An on-time seat on the listing keeps today's listing-wide access.
  expect(hidden("batch-1", "2026-09-24T12:00:00Z", false)).toBe(false);
});
