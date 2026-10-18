/**
 * @jest-environment node
 */

// The allocator's event read selects only live availability: ended custom rows never load, yet still count as configured.

import { fetchEventData } from "@/lib/booking/allocation/event-data";
import { findAvailableSlots } from "@/lib/booking/allocation/search/find-available-slots";
import { SlotShortageError } from "@/utils/scheduling-engine/errors";
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

it("a consultant whose custom rows have all ended still reads as configured: a shortage, not NO_AVAILABILITY", async () => {
  const consultant = {
    userId: "consultant-1",
    scheduleType: "CUSTOM" as const,
    availabilityWindowsWeekly: [],
    availabilityWindowsCustom: [],
    hasCustomRows: true,
  };
  const db = {
    appointment: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaLike;

  await expect(
    findAvailableSlots(db, consultant, 2, 2, "consultation", {
      durationInHours: 1,
    }),
  ).rejects.toBeInstanceOf(SlotShortageError);
});
