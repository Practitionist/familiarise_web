/**
 * #1703 D1 — the expert page decides its CTA from `bookingMode`, not from the
 * slot's contention alone: REQUEST routes every slot through approval and
 * says so; INSTANT keeps the pre-#1703 arm (pay on a free slot, request on a
 * contended one). The badge is the same reading in two words.
 */
import {
  bookingModeBadge,
  consultationCtaFor,
} from "@/lib/booking/booking-mode";

describe("consultation CTA by booking mode", () => {
  it("REQUEST asks for approval on every slot, free or contended", () => {
    for (const contended of [false, true]) {
      const cta = consultationCtaFor("REQUEST", contended);
      expect(cta.action).toBe("request");
      expect(cta.hint).toMatch(/confirms before you pay/);
    }
  });

  it("INSTANT pays now on a free slot and requests only a contended one", () => {
    expect(consultationCtaFor("INSTANT", false)).toEqual({
      action: "checkout",
      label: "Continue to Checkout",
      hint: null,
    });
    expect(consultationCtaFor("INSTANT", true).action).toBe("request");
  });

  it("the badge names the mode, and the pause when it applies", () => {
    expect(bookingModeBadge("INSTANT", true)).toBe("Instant booking");
    expect(bookingModeBadge("REQUEST", true)).toBe("Requests reviewed first");
    expect(bookingModeBadge("REQUEST", false)).toBe("Not taking new requests");
  });
});
