/**
 * Approving a paid request confirms its held times only while neither calendar
 * has gained another occupying row there; the refusal is party-neutral.
 */
import "./setup";

const mockRevalidate = jest.fn();
jest.mock("../../utils/scheduling-engine/ScheduleValidationService", () => ({
  ScheduleValidationService: jest.fn().mockImplementation(() => ({
    revalidateConflicts: mockRevalidate,
  })),
}));

import { assertHeldTimesStillFree } from "@/lib/booking/approve-recheck";
import type { Tx } from "@/lib/prisma";

const START = new Date("2031-03-03T10:00:00.000Z");
const tx = {
  appointment: {
    findUnique: async () => ({
      participants: [
        { userId: "u-host", role: "CONSULTANT" },
        { userId: "u-buyer", role: "CONSULTEE" },
      ],
      occurrences: [
        {
          startsAt: START,
          endsAt: new Date(START.getTime() + 3_600_000),
          consultantProfileId: "cp-host",
        },
      ],
    }),
  },
} as unknown as Tx;

beforeEach(() => mockRevalidate.mockReset());

it("re-checks every held half hour against both calendars, excluding the booking itself", async () => {
  mockRevalidate.mockResolvedValue({ isValid: true, errors: [], warnings: [] });

  await assertHeldTimesStillFree(tx, "appt-1");

  expect(mockRevalidate).toHaveBeenCalledWith(
    [START, new Date(START.getTime() + 1_800_000)],
    "u-host",
    ["appt-1"],
    "u-buyer",
    undefined,
    "cp-host",
  );
});

it("refuses with SCHEDULE_CONFLICT and names no other party", async () => {
  mockRevalidate.mockResolvedValue({
    isValid: false,
    errors: ["Conflicts with Priya's booking"],
    warnings: [],
  });

  const refusal = await assertHeldTimesStillFree(tx, "appt-1").catch(
    (error: unknown) => error,
  );
  expect(refusal).toMatchObject({ code: "SCHEDULE_CONFLICT", httpStatus: 409 });
  expect((refusal as Error).message).not.toMatch(/Priya/);
});
