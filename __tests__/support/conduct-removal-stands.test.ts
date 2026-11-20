/**
 * @jest-environment node
 */

/**
 * A conduct removal stands from its case: not overturned and no lift since. A
 * seat with no mark (a removal from before the mark existed) still stands, so
 * its call block holds and its rejoin is refused.
 */
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import type { PrismaLike } from "@/lib/prisma";
import { conductRemovalStands } from "@/lib/support/conduct-removal-state";

function db(opts: { marked: boolean; overturned?: boolean; lifted?: boolean }) {
  return {
    supportCase: {
      findFirst: async () => ({
        id: "case-1",
        createdAt: new Date("2026-11-10T10:00:00Z"),
      }),
    },
    supportCaseDecision: {
      findFirst: async () => (opts.overturned ? { id: "dec-1" } : null),
    },
    appointmentParticipant: {
      findUnique: async () => ({
        id: "part-1",
        removedByUserId: opts.marked ? "host-1" : null,
      }),
    },
    bookingStatusHistory: {
      findFirst: async () => (opts.lifted ? { id: "lift-1" } : null),
    },
  } as unknown as PrismaLike;
}

const stands = (opts: Parameters<typeof db>[0]) =>
  conductRemovalStands("appt-1", "u-1", db(opts));

it("stands for a seat with no mark while its case is neither overturned nor lifted", async () => {
  await expect(stands({ marked: false })).resolves.toBe(true);
});

it("stands for a marked seat the same way", async () => {
  await expect(stands({ marked: true })).resolves.toBe(true);
});

it.each([
  ["overturned", { marked: false, overturned: true }],
  ["lifted since the case", { marked: false, lifted: true }],
])("no longer stands once %s", async (_label, opts) => {
  await expect(stands(opts)).resolves.toBe(false);
});
