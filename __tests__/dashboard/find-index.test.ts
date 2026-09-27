/**
 * #1527 — Find lists exactly the sidebar plus the settings sections the
 * viewer can open, never a page the rail would hide; synonyms match.
 */

import { buildFindIndex, filterFind } from "@/lib/dashboard/nav/find-index";
import { buildOrganizationNav } from "@/lib/dashboard/nav/organization";
import { flattenNav } from "@/lib/dashboard/nav/types";
import { orgSettingsGroups } from "@/lib/dashboard/org-settings-sections";

describe("Find index", () => {
  it("a BILLING_ADMIN's index is the rail plus their settings sections", () => {
    const nav = buildOrganizationNav({
      orgId: "org-1",
      role: "BILLING_ADMIN",
      canSponsor: true,
      canHost: true,
      consultantProfileId: null,
    });
    const settings = orgSettingsGroups("org-1", "BILLING_ADMIN");
    const index = buildFindIndex({ nav, settings });
    expect(new Set(index.map((e) => e.href))).toEqual(
      new Set([
        ...flattenNav(nav).map((i) => `${nav.basePath}/${i.path}`),
        ...settings.flatMap((g) => g.sections.map((s) => s.href)),
      ]),
    );
    expect(index.map((e) => e.href)).not.toContain(
      "/dashboard/organization/org-1/settings/general",
    );
    expect(filterFind(index, "invoice").map((e) => e.label)).toContain(
      "Billing",
    );
  });
});
