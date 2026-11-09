import { nextAvailableWindow } from "@/lib/scheduling/booking-windows";

const NOW = Date.parse("2026-11-09T06:00:00Z");
const atom = (startsAt: string, extra: Record<string, unknown> = {}) => ({
  startsAt,
  endsAt: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString(),
  ...extra,
});

describe("nextAvailableWindow", () => {
  it("returns the earliest free window of the first day that has one", () => {
    const days = {
      "2026-11-11": [
        atom("2026-11-11T10:00:00Z"),
        atom("2026-11-11T10:30:00Z"),
      ],
      "2026-11-10": [
        atom("2026-11-10T09:00:00Z", { bookingStatus: "fully-booked" }),
        atom("2026-11-10T09:30:00Z"),
        atom("2026-11-10T10:00:00Z"),
      ],
    };
    const next = nextAvailableWindow(days, 0.5, "UTC", NOW);
    expect(next?.startsAt).toBe("2026-11-10T09:30:00.000Z");
  });

  it("skips times that are too soon or over a plan limit", () => {
    const days = {
      "2026-11-09": [
        atom("2026-11-09T06:30:00Z", { tooSoon: true }),
        atom("2026-11-09T07:00:00Z", { limitReached: true }),
      ],
      "2026-11-10": [atom("2026-11-10T08:00:00Z")],
    };
    expect(nextAvailableWindow(days, 0.5, "UTC", NOW)?.startsAt).toBe(
      "2026-11-10T08:00:00.000Z",
    );
  });

  it("needs a contiguous run as long as the session", () => {
    const days = {
      "2026-11-10": [
        atom("2026-11-10T09:00:00Z"),
        atom("2026-11-10T10:00:00Z"),
      ],
      "2026-11-11": [
        atom("2026-11-11T09:00:00Z"),
        atom("2026-11-11T09:30:00Z"),
      ],
    };
    expect(nextAvailableWindow(days, 1, "UTC", NOW)?.startsAt).toBe(
      "2026-11-11T09:00:00.000Z",
    );
  });

  it("returns null when nothing is open", () => {
    expect(nextAvailableWindow({}, 1, "UTC", NOW)).toBeNull();
    expect(
      nextAvailableWindow(
        {
          "2026-11-10": [
            atom("2026-11-10T09:00:00Z", {
              isAllocated: true,
              bookingStatus: "fully-booked",
            }),
          ],
        },
        0.5,
        "UTC",
        NOW,
      ),
    ).toBeNull();
  });
});
