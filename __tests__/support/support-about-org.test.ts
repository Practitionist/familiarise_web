/**
 * #1527 — "About: <org>" on a new support request: offered, and accepted by
 * the create route, only on an ACTIVE membership that reads the org's support
 * requests (operations.read OR billing.read).
 */

import { canRaiseAboutOrg } from "@/lib/support/about-org";

describe("canRaiseAboutOrg", () => {
  it.each([
    ["OWNER", "ACTIVE", true],
    ["MANAGER", "ACTIVE", true],
    ["SUPPORT", "ACTIVE", true],
    ["BILLING_ADMIN", "ACTIVE", true],
    ["EXPERT", "ACTIVE", false],
    ["LEARNER", "ACTIVE", false],
    ["OWNER", "SUSPENDED", false],
  ])("%s · %s → %s", (role, status, expected) => {
    expect(canRaiseAboutOrg({ role, status })).toBe(expected);
  });
});
