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
import {
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

  // #1527 QA K10 — the Requests switch PUT the whole profile and a stale
  // availability overlap 400'd it silently. It now PATCHes only its flag and
  // surfaces the server's sentence.
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

    await expect(
      saveBookingRequestSettings("cp-1", { acceptingRequests: false }),
    ).resolves.toMatchObject({ acceptingRequests: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/user/consultants/cp-1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ acceptingRequests: false });

    await expect(
      saveBookingRequestSettings("cp-1", { acceptingRequests: true }),
    ).rejects.toThrow("Validation failed");
  });
});
