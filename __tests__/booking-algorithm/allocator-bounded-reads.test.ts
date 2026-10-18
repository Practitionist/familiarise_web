/**
 * @jest-environment node
 */

// The allocator's event read selects only live availability: custom rows that have ended never load.

import { fetchEventData } from "@/lib/booking/allocation/event-data";
import type { PrismaLike } from "@/lib/prisma";

it("reads only custom rows still ending in the future, and selects rather than includes", async () => {
  const findUnique = jest.fn().mockResolvedValue({
    consultationPlan: {
      durationInHours: 1,
      consultantProfile: {
        user: { id: "consultant-1", timezone: null },
        scheduleType: "CUSTOM",
        availabilityWindowsWeekly: [],
        availabilityWindowsCustom: [],
      },
    },
    requestedBy: { user: { id: "consultee-1" } },
    appointment: null,
  });
  const db = { consultation: { findUnique } } as unknown as PrismaLike;

  const before = Date.now();
  await fetchEventData(db, "consultation", "consult-1");

  const args = findUnique.mock.calls[0][0];
  expect(args).not.toHaveProperty("include");
  const profile = args.select.consultationPlan.select.consultantProfile.select;
  expect(profile.availabilityWindowsCustom).toEqual({
    where: { endsAt: { gt: expect.any(Date) } },
    select: { id: true, startsAt: true, endsAt: true },
  });
  const bound: Date = profile.availabilityWindowsCustom.where.endsAt.gt;
  expect(bound.getTime()).toBeGreaterThanOrEqual(before);
  expect(profile.user).toEqual({ select: { id: true, timezone: true } });
});
