/**
 * @jest-environment node
 */

/**
 * Planner group: every consultantProfile relation the planner reads is an
 * explicit select. The route itself is driven in
 * `__tests__/dashboards/planner-class-join-payload.test.ts`, which owns its mocks.
 */

import { allKeys, readSource as read } from "../fixtures/consultant-projection";
import { PROFILE_OWNER_SELECT } from "@/lib/booking/list-selects";
import { CONSULTANT_PII_FIELDS } from "@/lib/data/consultant-public";

describe("planner sources use explicit consultantProfile projections", () => {
  const files = [
    "app/api/dashboard/consultant/[consultantId]/planner/route.ts",
    "lib/data/consultant-dashboard.ts",
  ];

  it.each(files)("%s has no bare consultantProfile fetch", (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/consultantProfile:\s*true/);
    expect(src).not.toMatch(/consultantProfile:\s*\{\s*include/);
    expect(src).not.toMatch(/consultantProfile:\s*\{[^}]*user:\s*true/);
  });

  it("the planner route references PROFILE_OWNER_SELECT for both plan kinds", () => {
    const src = read(
      "app/api/dashboard/consultant/[consultantId]/planner/route.ts",
    );
    expect(
      src.match(/consultantProfile:\s*PROFILE_OWNER_SELECT/g),
    ).toHaveLength(2);
  });

  it("planOwnerSelect exposes the plan owner without an email", () => {
    const src = read("lib/data/consultant-dashboard.ts");
    const start = src.indexOf("const planOwnerSelect = {");
    const block = src.slice(start, src.indexOf("} as const;", start));
    expect(start).toBeGreaterThan(-1);
    expect(block).toMatch(
      /user:\s*\{\s*select:\s*\{\s*id: true, name: true, image: true\s*\}\s*\}/,
    );
    expect(block).not.toMatch(/\bemail\b/);
  });

  it("PROFILE_OWNER_SELECT carries no statutory PII column", () => {
    const keys = allKeys(PROFILE_OWNER_SELECT);
    const leaked = CONSULTANT_PII_FIELDS.filter((f) => keys.includes(f));
    expect(leaked).toEqual([]);
  });
});
