/**
 * @jest-environment node
 */

/**
 * Deterministic multi-org fallback for the dashboard router + layout seed.
 * The session's organizationMemberships array has no ORDER BY, so picking
 * [0] flickered between orgs across logins. selectFallbackOrgMembership
 * ranks by ORG_ROLE_RANK (operate > deliver > consume) with slug tie-break.
 *
 * Pure module — no Prisma imports here.
 */

import { selectFallbackOrgMembership } from "../../lib/labels/org-labels";

const m = (organizationId: string, organizationSlug: string, role: string) => ({
  organizationId,
  organizationSlug,
  role,
});

describe("selectFallbackOrgMembership", () => {
  it("returns null for empty / missing input", () => {
    expect(selectFallbackOrgMembership([])).toBeNull();
    expect(selectFallbackOrgMembership(null)).toBeNull();
    expect(selectFallbackOrgMembership(undefined)).toBeNull();
  });

  it("returns the only membership", () => {
    const only = m("org-1", "acme", "LEARNER");
    expect(selectFallbackOrgMembership([only])).toBe(only);
  });

  it("prefers the highest-ranked role regardless of array order", () => {
    const learner = m("org-learner", "zebra", "LEARNER");
    const owner = m("org-owner", "acme", "OWNER");
    const expert = m("org-expert", "acme", "EXPERT");
    expect(selectFallbackOrgMembership([learner, expert, owner])).toBe(owner);
    expect(selectFallbackOrgMembership([owner, learner])).toBe(owner);
    expect(selectFallbackOrgMembership([learner, expert])).toBe(expert);
  });

  it("breaks rank ties by slug ascending (stable across logins)", () => {
    const b = m("org-b", "bravo", "LEARNER");
    const a = m("org-a", "alpha", "LEARNER");
    expect(selectFallbackOrgMembership([b, a])).toBe(a);
    expect(selectFallbackOrgMembership([a, b])).toBe(a);
  });

  it("sends unknown roles to the back without throwing", () => {
    const known = m("org-1", "acme", "LEARNER");
    const strange = m("org-2", "acme", "FUTURE_ROLE");
    expect(selectFallbackOrgMembership([strange, known])).toBe(known);
  });
});
