/**
 * @jest-environment node
 */

/**
 * #1785 — the Settings hub. L-1: Availability left Settings for the sidebar,
 * so the retired `settings?tab=availability` deep link answers a 308 to
 * `/availability`. L-2: every section has its own URL, no two share one, and
 * every legacy `?tab=<key>` lands on exactly one of them.
 */

import SettingsPage from "@/app/dashboard/consultant/[consultantId]/(features)/settings/page";
import {
  SETTINGS_SECTIONS,
  settingsSectionGroups,
  settingsSectionHref,
  settingsTabRedirect,
} from "@/app/dashboard/consultant/[consultantId]/(features)/settings/settings";

const BASE = "/dashboard/consultant/cp-1";

/** Runs the server page and returns the redirect it threw, if any. */
async function redirectOf(searchParams: Record<string, string>) {
  try {
    await SettingsPage({
      params: Promise.resolve({ consultantId: "cp-1" }),
      searchParams: Promise.resolve(searchParams),
    });
    return null;
  } catch (error) {
    // Next encodes a redirect as `NEXT_REDIRECT;<type>;<url>;<status>;`.
    const digest = (error as { digest?: string }).digest ?? "";
    const [, , url, status] = digest.split(";");
    return { url, status: Number(status) };
  }
}

describe("settings hub redirects (#1785)", () => {
  it("sends ?tab=availability to the top-level Availability page as a 308", async () => {
    await expect(redirectOf({ tab: "availability" })).resolves.toEqual({
      url: `${BASE}/availability`,
      status: 308,
    });
  });

  it("sends a bare /settings and an unknown tab to the first section", async () => {
    // #1527 §14 — Account leads the hub now.
    await expect(redirectOf({})).resolves.toEqual({
      url: `${BASE}/settings/account`,
      status: 308,
    });
    await expect(redirectOf({ tab: "nope" })).resolves.toEqual({
      url: `${BASE}/settings/account`,
      status: 308,
    });
  });

  it("keeps the retired security key as an alias of Account", async () => {
    await expect(redirectOf({ tab: "security" })).resolves.toEqual({
      url: `${BASE}/settings/account`,
      status: 308,
    });
  });
});

describe("settings section registry (#1785 L-2)", () => {
  it("gives every section a unique URL in the locked group order", () => {
    const hrefs = SETTINGS_SECTIONS.map((s) => settingsSectionHref(BASE, s));
    expect(new Set(hrefs).size).toBe(SETTINGS_SECTIONS.length);
    expect(settingsSectionGroups().map((g) => g.title)).toEqual([
      "Account",
      "Public profile",
      "Business",
    ]);
  });

  it("maps every legacy ?tab= key onto exactly one section URL", () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(settingsTabRedirect(BASE, section.key)).toBe(
        settingsSectionHref(BASE, section),
      );
    }
  });
});
