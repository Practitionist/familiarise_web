/**
 * #1527 QA P0 — a dual-role user switching Expert → Client must not be
 * bounced back by a denial judged on a cached viewer row, and a layout the
 * URL has already left must never navigate.
 */
import { personalAccessDecision } from "@/lib/dashboard/personal-access";

const base = "/dashboard/consultee/ce-1";
const input = {
  hasUser: true,
  hasAccess: false,
  verified: false,
  pathname: `${base}/home`,
  basePath: base,
};

describe("personalAccessDecision", () => {
  it("renders owners and still-loading viewers", () => {
    expect(personalAccessDecision({ ...input, hasAccess: true })).toBe(
      "render",
    );
    expect(personalAccessDecision({ ...input, hasUser: false })).toBe("render");
  });

  it("re-reads the viewer before denying on a cached row", () => {
    expect(personalAccessDecision(input)).toBe("verify");
    expect(personalAccessDecision({ ...input, verified: true })).toBe(
      "redirect",
    );
  });

  it("never navigates from a tree the URL has left", () => {
    expect(
      personalAccessDecision({
        ...input,
        verified: true,
        pathname: "/dashboard/consultant/cp-1/home",
      }),
    ).toBe("hold");
    // A sibling id sharing the prefix is not this tree.
    expect(
      personalAccessDecision({ ...input, pathname: `${base}0/home` }),
    ).toBe("hold");
  });
});
