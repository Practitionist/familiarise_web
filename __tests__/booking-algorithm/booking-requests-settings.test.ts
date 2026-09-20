/**
 * @jest-environment node
 */

/**
 * #1703 D1/D4 — the "Booking requests" settings section: the cap input reads
 * blank as "no limit" and clamps into 1–50, and the form seeds the three
 * fields from the profile with the schema defaults when they are absent.
 */
import {
  MAX_OPEN_REQUESTS_RANGE,
  parseMaxOpenRequests,
} from "@/app/dashboard/consultant/[consultantId]/(features)/settings/sections/BookingRequestsSection";
import { getInitialFormData } from "@/app/dashboard/consultant/[consultantId]/(features)/settings/settings";
import type { TConsultantProfile } from "@/types/consultant";

describe("booking requests settings", () => {
  it("blank clears the cap; values clamp into the accepted range", () => {
    expect(parseMaxOpenRequests("", 5)).toBeNull();
    expect(parseMaxOpenRequests("  ", 5)).toBeNull();
    expect(parseMaxOpenRequests("0", null)).toBe(MAX_OPEN_REQUESTS_RANGE.min);
    expect(parseMaxOpenRequests("500", null)).toBe(MAX_OPEN_REQUESTS_RANGE.max);
    expect(parseMaxOpenRequests("7", null)).toBe(7);
  });

  it("only blank clears: unparseable keeps the cap, fractions truncate", () => {
    expect(parseMaxOpenRequests("abc", 5)).toBe(5);
    expect(parseMaxOpenRequests("abc", null)).toBeNull();
    expect(parseMaxOpenRequests("1.5", 5)).toBe(1);
  });

  it("seeds the form from the profile, defaulting to INSTANT / accepting / no cap", () => {
    const seeded = getInitialFormData({
      bookingMode: "REQUEST",
      acceptingRequests: false,
      maxOpenRequests: 5,
    } as unknown as TConsultantProfile);
    expect(seeded.bookingMode).toBe("REQUEST");
    expect(seeded.acceptingRequests).toBe(false);
    expect(seeded.maxOpenRequests).toBe(5);

    const bare = getInitialFormData({} as unknown as TConsultantProfile);
    expect(bare.bookingMode).toBe("INSTANT");
    expect(bare.acceptingRequests).toBe(true);
    expect(bare.maxOpenRequests).toBeNull();
  });
});
