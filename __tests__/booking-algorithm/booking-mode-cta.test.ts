/**
 * The expert page decides its button from `bookingMode` alone: REQUEST routes
 * every time through approval and says so; INSTANT pays now, and a held time
 * is taken, never a request. The badge is the same reading in two words.
 */
import {
  bookingModeBadge,
  consultationCtaFor,
} from "@/lib/booking/booking-mode";

describe("consultation CTA by booking mode", () => {
  it("REQUEST asks for approval and says the expert confirms first", () => {
    const cta = consultationCtaFor("REQUEST");
    expect(cta.action).toBe("request");
    expect(cta.label).toBe("Request this time");
    expect(cta.hint).toMatch(/confirms before you pay/);
  });

  it("INSTANT always continues to checkout", () => {
    expect(consultationCtaFor("INSTANT")).toEqual({
      action: "checkout",
      label: "Continue to Checkout",
      hint: null,
    });
  });

  it("the badge names the mode, and the pause when it applies", () => {
    expect(bookingModeBadge("INSTANT", true)).toBe("Instant booking");
    expect(bookingModeBadge("REQUEST", true)).toBe("Requests reviewed first");
    expect(bookingModeBadge("REQUEST", false)).toBe(
      "Not taking new 1:1 bookings",
    );
    expect(bookingModeBadge("INSTANT", false)).toBe(
      "Not taking new 1:1 bookings",
    );
  });
});
