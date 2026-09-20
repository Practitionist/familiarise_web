/**
 * @jest-environment node
 */

/**
 * #1785 — Availability left Settings for the sidebar (L-1), so the retired
 * `settings?tab=availability` deep link must answer a 308 to `/availability`.
 */

import SettingsPage from "@/app/dashboard/consultant/[consultantId]/(features)/settings/page";

jest.mock(
  "../../app/dashboard/consultant/[consultantId]/(features)/settings/SettingsPageClient",
  () => ({ SettingsPageClient: () => null }),
);

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

describe("settings?tab= redirects (#1785)", () => {
  it("sends ?tab=availability to the top-level Availability page as a 308", async () => {
    await expect(redirectOf({ tab: "availability" })).resolves.toEqual({
      url: `${BASE}/availability`,
      status: 308,
    });
  });

  it("renders the hub itself when there is no tab to redirect", async () => {
    await expect(redirectOf({})).resolves.toBeNull();
  });
});
