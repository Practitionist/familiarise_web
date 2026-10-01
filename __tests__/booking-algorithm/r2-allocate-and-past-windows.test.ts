/**
 * @jest-environment node
 */

/**
 * #1780 R-2 — the allocate page's read answers null (so the page reaches its
 * notFound) for a request owned by another consultant or one that fails to
 * read; an availability save that carries an old, unchanged past window plus
 * a valid new one is accepted, while a new past window is still refused.
 */

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
const findUnique = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: { findUnique: (...a: unknown[]) => findUnique(...a) },
  },
}));

import { readAllocationRequest } from "@/lib/data/allocation-request";
import { validateCustomWindows } from "@/lib/scheduling/availability-contract";
import { dropUnchangedPastWindows } from "@/lib/scheduling/past-windows";

it("a foreign request, or one that throws, reads as not found", async () => {
  findUnique.mockResolvedValueOnce({
    id: "c-1",
    status: "PENDING",
    requestedBy: null,
    consultationPlan: {
      title: "Plan",
      consultantProfileId: "cp-other",
      durationInHours: 1,
    },
    appointment: null,
  });
  await expect(
    readAllocationRequest("c-1", "consultation", "cp-me"),
  ).resolves.toBeNull();
  findUnique.mockRejectedValueOnce(new Error("boom"));
  await expect(
    readAllocationRequest("c-1", "consultation", "cp-me"),
  ).resolves.toBeNull();
});

it("an old unchanged past window is dropped; a new past window still refuses", () => {
  const now = new Date("2026-09-25T12:00:00Z");
  const past = {
    startsAt: new Date("2026-09-20T10:00:00Z"),
    endsAt: new Date("2026-09-20T11:00:00Z"),
  };
  const fresh = {
    startsAt: new Date("2026-09-30T10:00:00Z"),
    endsAt: new Date("2026-09-30T11:00:00Z"),
  };
  const kept = dropUnchangedPastWindows([past, fresh], [past], now);
  expect(validateCustomWindows(kept, { now })).toBeNull();
  const newPast = dropUnchangedPastWindows([past, fresh], [], now);
  expect(validateCustomWindows(newPast, { now })?.code).toBe("PAST");
});
