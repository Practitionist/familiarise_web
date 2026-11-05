/**
 * @jest-environment node
 */
/**
 * Regular-time plans leave the week ladder: their consultant gets one bell a
 * local day, inside waking hours, listing the plans whose horizon has
 * conflicts, deduped by the outbox key; no conflicts, no bell.
 */
const mockPrisma = {
  notificationPreference: { findMany: jest.fn() },
  notificationOutbox: { findMany: jest.fn() },
};
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockPrisma;
  },
}));
jest.mock("@/lib/novu/service", () => ({ notifyUnplacedWeekNudge: jest.fn() }));

import { notifyUnplacedWeekNudge } from "@/lib/novu/service";
import { deriveTransactionId } from "@/lib/novu/outbox";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import {
  conflictSummary,
  nudgeRegularTimeConflicts,
  regularConflictsDedupeKey,
} from "@/lib/booking/week-nudge";

const plans = [
  { consulteeName: "Priya", planTitle: "Maths", toFix: 2, url: "https://x/a" },
];
const due = (localDay: string) => [
  {
    consultantProfileId: "cp-1",
    userId: "expert-1",
    zone: "Asia/Kolkata",
    localDay,
    plans,
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.notificationPreference.findMany.mockResolvedValue([]);
  mockPrisma.notificationOutbox.findMany.mockResolvedValue([]);
});

describe("nudgeRegularTimeConflicts (T20)", () => {
  it("sends one bell per consultant per local day, keyed roll-conflicts:<consultant>:<day>", async () => {
    const noon = new Date("2026-11-02T06:30:00Z"); // 12:00 IST
    const out = await nudgeRegularTimeConflicts(due("2026-11-02"), noon);
    expect(out.nudged).toBe(1);
    expect(notifyUnplacedWeekNudge).toHaveBeenCalledWith(
      "expert-1",
      expect.objectContaining({
        weekSummary: "Priya's plan has 2 regular times to fix.",
        dashboardUrl: "https://x/a",
      }),
      "roll-conflicts:cp-1:2026-11-02",
    );

    mockPrisma.notificationOutbox.findMany.mockResolvedValue([
      {
        transactionId: deriveTransactionId(
          NOVU_WORKFLOWS.NEW_BOOKING_REQUEST,
          ["expert-1"],
          {},
          regularConflictsDedupeKey("cp-1", "2026-11-02"),
        ),
      },
    ]);
    jest.mocked(notifyUnplacedWeekNudge).mockClear();
    expect(
      (await nudgeRegularTimeConflicts(due("2026-11-02"), noon)).nudged,
    ).toBe(0);
    expect(notifyUnplacedWeekNudge).not.toHaveBeenCalled();
  });

  it("stays quiet outside 08:00–21:00 local and with nothing to fix", async () => {
    const late = new Date("2026-11-02T17:00:00Z"); // 22:30 IST
    expect(
      (await nudgeRegularTimeConflicts(due("2026-11-02"), late)).nudged,
    ).toBe(0);
    const noon = new Date("2026-11-02T06:30:00Z");
    expect(
      (
        await nudgeRegularTimeConflicts(
          [{ ...due("2026-11-02")[0], plans: [] }],
          noon,
        )
      ).nudged,
    ).toBe(0);
    expect(notifyUnplacedWeekNudge).not.toHaveBeenCalled();
  });

  it("summarises several plans in one line", () => {
    expect(
      conflictSummary([
        { consulteeName: "Priya", toFix: 1 },
        { consulteeName: "Ravi", toFix: 3 },
      ]),
    ).toBe(
      "Priya's plan has 1 regular time to fix, and 1 more plan needs a look.",
    );
  });
});
