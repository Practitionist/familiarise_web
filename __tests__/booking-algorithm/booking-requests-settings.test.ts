/**
 * @jest-environment node
 */

/**
 * The "Booking mode" settings: the cap input reads blank as "no limit"
 * and clamps into 1–50, the form seeds the three fields from the profile with
 * the schema defaults, and a save sends only what changed with the value it
 * replaces.
 */
import {
  MAX_OPEN_REQUESTS_RANGE,
  parseMaxOpenRequests,
} from "@/app/dashboard/consultant/[consultantId]/(features)/settings/sections/BookingRequestsSection";
import {
  bookingRequestSettingsChange,
  getInitialBookingRequestSettings,
  getInitialFormData,
  saveBookingRequestSettings,
} from "@/app/dashboard/consultant/[consultantId]/(features)/settings/settings";
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
    const seeded = getInitialBookingRequestSettings({
      bookingMode: "REQUEST",
      acceptingRequests: false,
      maxOpenRequests: 5,
    } as unknown as TConsultantProfile);
    expect(seeded.bookingMode).toBe("REQUEST");
    expect(seeded.acceptingRequests).toBe(false);
    expect(seeded.maxOpenRequests).toBe(5);

    const bare = getInitialBookingRequestSettings(
      {} as unknown as TConsultantProfile,
    );
    expect(bare.bookingMode).toBe("INSTANT");
    expect(bare.acceptingRequests).toBe(true);
    expect(bare.maxOpenRequests).toBeNull();
    expect(bare.maxActivePlanClients).toBeNull();
  });

  it("the whole-profile form no longer carries the booking settings", () => {
    const profile = getInitialFormData({
      acceptingRequests: false,
    } as unknown as TConsultantProfile);
    expect(profile).not.toHaveProperty("acceptingRequests");
    expect(profile).not.toHaveProperty("bookingMode");
    expect(profile).not.toHaveProperty("maxOpenRequests");
  });

  it("a change names only the edited fields, each with the value it replaces", () => {
    const shown = {
      bookingMode: "INSTANT" as const,
      acceptingRequests: true,
      maxOpenRequests: 5,
      maxActivePlanClients: null,
    };
    expect(bookingRequestSettingsChange(shown, { ...shown })).toBeNull();
    expect(
      bookingRequestSettingsChange(shown, { ...shown, maxOpenRequests: null }),
    ).toEqual({
      set: { maxOpenRequests: null },
      expect: { maxOpenRequests: 5 },
    });
    expect(
      bookingRequestSettingsChange(shown, {
        ...shown,
        maxActivePlanClients: 4,
      }),
    ).toEqual({
      set: { maxActivePlanClients: 4 },
      expect: { maxActivePlanClients: null },
    });
  });

  // The Requests switch PATCHes only its flag and surfaces the server's sentence.
  it("PATCHes only the given setting and throws the server's refusal", async () => {
    const json = (body: unknown, status: number) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        json(
          {
            data: {
              bookingMode: "REQUEST",
              acceptingRequests: false,
              maxOpenRequests: null,
            },
          },
          200,
        ),
      )
      .mockResolvedValueOnce(json({ error: "Validation failed" }, 400));
    global.fetch = fetchMock as unknown as typeof fetch;

    const pause = {
      set: { acceptingRequests: false },
      expect: { acceptingRequests: true },
    };
    await expect(
      saveBookingRequestSettings("cp-1", pause),
    ).resolves.toMatchObject({ acceptingRequests: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/user/consultants/cp-1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual(pause);

    await expect(saveBookingRequestSettings("cp-1", pause)).rejects.toThrow(
      "Validation failed",
    );
  });
});
