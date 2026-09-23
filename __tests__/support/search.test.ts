/**
 * @jest-environment node
 *
 * Covers the `/support` hero search ranking: empty queries, direct matches,
 * and synonym expansion (user language → article language).
 */
import { searchSupport } from "@/app/support/_data/support-content";

function slugs(query: string): string[] {
  return searchSupport(query).map((a) => `${a.category}/${a.slug}`);
}

describe("searchSupport", () => {
  it("returns nothing for empty queries", () => {
    expect(searchSupport("")).toEqual([]);
    expect(searchSupport("   ")).toEqual([]);
  });

  it("matches titles directly", () => {
    expect(slugs("How do I reschedule a session?")).toContain(
      "booking/reschedule",
    );
  });

  it("expands refund → cancellation content", () => {
    const found = slugs("refund status");
    expect(found).toContain("payments/refunds-explained");
    expect(found).toContain("booking/cancel-and-no-show");
  });

  it("expands UPI → payment methods content", () => {
    expect(slugs("upi failed")).toContain(
      "payments/payment-methods-and-failures",
    );
  });

  it("expands SSO → identity content", () => {
    const found = slugs("sso");
    expect(found).toContain("getting-started/sso-sign-in");
    expect(found).toContain("organizations/sso-scim-setup");
  });

  it("matches body text, not just titles", () => {
    expect(slugs("quiet hours")).toContain("help/quiet-hours");
    expect(slugs("consecutive slots")).toContain("booking/picking-slots");
  });

  it("returns nothing for gibberish", () => {
    expect(searchSupport("xqzt kpwmn zzz")).toEqual([]);
  });

  it("matches whole words, not substrings", () => {
    // "discard" must not fire the "card" payment synonym.
    expect(searchSupport("discard")).toEqual([]);
    // Plurals still match singulars.
    expect(slugs("refunds")).toContain("payments/refunds-explained");
  });
});
