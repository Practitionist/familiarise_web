/**
 * Q1 + Q3 — notification prefs wiring.
 * Pins: the bell skip rule gates on routing + master + in-app + category, and
 * quiet-hours deferral computes the window-end (or null when it must not).
 */

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { inAppSkipRule } from "@/lib/novu/templates/conditions";
import { computeQuietHoursNotBefore } from "@/lib/novu/quiet-hours";

function flagsOf(rule: { and: { "!=": [{ var: string }, "false"] }[] }) {
  return rule.and.map((clause) => clause["!="][0].var);
}

describe("inAppSkipRule (Q1 bell gating)", () => {
  it("gates every bell on routing, master toggle, and in-app channel", () => {
    const flags = flagsOf(inAppSkipRule("appointments"));
    expect(flags).toContain("subscriber.data.routingBell");
    expect(flags).toContain("subscriber.data.masterEnabled");
    expect(flags).toContain("subscriber.data.preferInApp");
    expect(flags).toContain("subscriber.data.categoryAppointments");
  });

  it("keeps routing + master + in-app gates for required (null-category) notices", () => {
    const flags = flagsOf(inAppSkipRule(null));
    expect(flags).toContain("subscriber.data.routingBell");
    expect(flags).toContain("subscriber.data.masterEnabled");
    expect(flags).toContain("subscriber.data.preferInApp");
    expect(flags).toHaveLength(3);
  });
});

describe("computeQuietHoursNotBefore (Q3 deferral)", () => {
  // 2026-09-19 01:30 UTC = 07:00 IST — inside a 22:00→08:00 IST window.
  const insideWindow = new Date("2026-09-19T01:30:00.000Z");
  // 2026-09-19 06:30 UTC = 12:00 IST — outside it.
  const outsideWindow = new Date("2026-09-19T06:30:00.000Z");

  const overnight = {
    quietHoursEnabled: true,
    quietHoursStart: "22:00",
    quietHoursEnd: "08:00",
    quietHoursTimezone: "Asia/Kolkata",
  };

  it("returns null when quiet hours are disabled", () => {
    expect(
      computeQuietHoursNotBefore(
        { ...overnight, quietHoursEnabled: false },
        insideWindow,
      ),
    ).toBeNull();
  });

  it("returns null outside the window", () => {
    expect(computeQuietHoursNotBefore(overnight, outsideWindow)).toBeNull();
  });

  it("defers to the window end when inside an overnight window", () => {
    const notBefore = computeQuietHoursNotBefore(overnight, insideWindow);
    expect(notBefore).not.toBeNull();
    // 07:00 IST + 60 min → 08:00 IST = 02:30 UTC (plus 1s boundary rounding).
    expect(notBefore!.getTime()).toBeGreaterThan(insideWindow.getTime());
    expect(notBefore!.getTime() - insideWindow.getTime()).toBeLessThanOrEqual(
      61 * 60 * 1000,
    );
  });

  it("handles a same-day window", () => {
    // 13:00 IST on 2026-09-19 = 07:30 UTC; window 12:00→14:00 IST.
    const noon = new Date("2026-09-19T07:30:00.000Z");
    const notBefore = computeQuietHoursNotBefore(
      {
        quietHoursEnabled: true,
        quietHoursStart: "12:00",
        quietHoursEnd: "14:00",
        quietHoursTimezone: "Asia/Kolkata",
      },
      noon,
    );
    expect(notBefore).not.toBeNull();
    expect(notBefore!.getTime()).toBeGreaterThan(noon.getTime());
  });

  it("returns null for invalid or degenerate config instead of throwing", () => {
    expect(
      computeQuietHoursNotBefore(
        { ...overnight, quietHoursStart: "not-a-time" },
        insideWindow,
      ),
    ).toBeNull();
    expect(
      computeQuietHoursNotBefore(
        { ...overnight, quietHoursStart: "08:00invalid" },
        insideWindow,
      ),
    ).toBeNull();
    expect(
      computeQuietHoursNotBefore(
        { ...overnight, quietHoursEnd: "08:00 " },
        insideWindow,
      ),
    ).not.toBeNull();
    expect(
      computeQuietHoursNotBefore(
        { ...overnight, quietHoursStart: "08:00", quietHoursEnd: "08:00" },
        insideWindow,
      ),
    ).toBeNull();
    expect(
      computeQuietHoursNotBefore({ ...overnight, quietHoursStart: null },
        insideWindow,
      ),
    ).toBeNull();
  });

  it("falls back to the user timezone then the platform default", () => {
    const notBefore = computeQuietHoursNotBefore(
      {
        quietHoursEnabled: true,
        quietHoursStart: "22:00",
        quietHoursEnd: "08:00",
        quietHoursTimezone: null,
        fallbackTimezone: "Asia/Kolkata",
      },
      insideWindow,
    );
    expect(notBefore).not.toBeNull();
  });
});
