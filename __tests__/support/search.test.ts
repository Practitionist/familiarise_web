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
    expect(found).toContain("organizations/sso-setup");
  });

  it("matches body text, not just titles", () => {
    expect(slugs("master switch")).toContain("help/notification-preferences");
    expect(slugs("consecutive slots")).toContain("booking/picking-slots");
  });

  it("routes dispute and message-review language to the new articles", () => {
    expect(slugs("dispute")).toContain("help/report-a-problem");
    expect(slugs("who reads my chat")).toContain("help/how-we-review-messages");
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
