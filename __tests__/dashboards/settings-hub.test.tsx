/**
 * @jest-environment node
 */

/** The Settings hub: every section has its own URL and no two share one. */

import {
  SETTINGS_SECTIONS,
  settingsSectionGroups,
  settingsSectionHref,
} from "@/app/dashboard/consultant/[consultantId]/(features)/settings/settings";

const BASE = "/dashboard/consultant/cp-1";

describe("settings section registry", () => {
  it("gives every section a unique URL in the locked group order", () => {
    const hrefs = SETTINGS_SECTIONS.map((s) => settingsSectionHref(BASE, s));
    expect(new Set(hrefs).size).toBe(SETTINGS_SECTIONS.length);
    expect(settingsSectionGroups().map((g) => g.title)).toEqual([
      "Account",
      "Public profile",
      "Business",
    ]);
  });
});
