/**
 * #1527 — Find lists exactly the sidebar plus the settings sections the
 * viewer can open, never a page the rail would hide; synonyms match, but a
 * label match ranks first.
 */

jest.mock("@/lib/auth-client", () => ({ useSession: jest.fn() }));

import { resolveBackofficeCapability } from "@/lib/backoffice/capability";
import { accountSettingsLinks } from "@/components/dashboard/DashboardShellParts";
import { buildWorkspaceNav } from "@/lib/dashboard/nav/workspace";
import { buildBackofficeDashboardNav } from "@/lib/dashboard/nav/backoffice";
import { buildConsultantNav } from "@/lib/dashboard/nav/consultant";
import { buildConsulteeNav } from "@/lib/dashboard/nav/consultee";
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

  it('an ADMIN\'s "invoice" ranks Invoices above its synonym pages', () => {
    const nav = buildBackofficeDashboardNav(
      resolveBackofficeCapability("ADMIN", "admin")!,
    );
    const results = filterFind(buildFindIndex({ nav }), "invoice");
    expect(results[0].href).toBe(`${nav.basePath}/invoices`);
    expect(results.map((e) => e.label)).toContain("Payments");
  });

  it("lists the account menu's My library once, and the workspace settings once", () => {
    const nav = buildWorkspaceNav("ow-1");
    const settingsHref = "/dashboard/org-workspace/ow-1/settings";
    const account = accountSettingsLinks({
      name: null,
      image: null,
      roleLabel: "",
      settingsHref,
      orgSettings: { label: "Workspace settings", href: settingsHref },
    });
    const index = buildFindIndex({ nav, account: [...account, ...account] });
    const library = index.filter((e) => e.href === "/dashboard/go/library");
    expect(library).toEqual([
      expect.objectContaining({ label: "My library", group: "Account" }),
    ]);
    expect(index.filter((e) => e.href === settingsHref)).toHaveLength(1);
    expect(filterFind(index, "purchases").map((e) => e.label)).toEqual([
      "My library",
    ]);
  });

  it("a learner's Library is listed once, and ebooks find it", () => {
    const nav = buildConsulteeNav("ce-1");
    const account = accountSettingsLinks({
      name: null,
      image: null,
      roleLabel: "",
      settingsHref: "/dashboard/consultee/ce-1/settings",
    });
    const index = buildFindIndex({ nav, account });
    const hits = (q: string) => filterFind(index, q).map((e) => e.href);
    expect(hits("library")).toEqual(["/dashboard/consultee/ce-1/library"]);
    expect(hits("ebooks")).toEqual(["/dashboard/consultee/ce-1/library"]);
  });

  it("a learner's credits find Billing, where the credit history lives", () => {
    const index = buildFindIndex({ nav: buildConsulteeNav("ce-1") });
    const hits = filterFind(index, "credits").map((e) => e.href);
    expect(hits).toContain("/dashboard/consultee/ce-1/payments");
    expect(hits).toContain("/dashboard/consultee/ce-1/referrals");
  });

  it("the old words still find the renamed pages", () => {
    const nav = buildOrganizationNav({
      orgId: "org-1",
      role: "OWNER",
      canSponsor: true,
      canHost: true,
      consultantProfileId: null,
    });
    const index = buildFindIndex({ nav });
    expect(filterFind(index, "recordings").map((e) => e.label)).toContain(
      "Library",
    );
    expect(filterFind(index, "support requests").map((e) => e.label)).toContain(
      "Help & support",
    );
  });

  it("synonyms are scoped per tree: org programs and library shed the expert words", () => {
    const org = buildFindIndex({
      nav: buildOrganizationNav({
        orgId: "org-1",
        role: "OWNER",
        canSponsor: true,
        canHost: true,
        consultantProfileId: null,
      }),
    });
    const orgHits = (q: string) => filterFind(org, q).map((e) => e.href);
    const orgBase = "/dashboard/organization/org-1";
    expect(orgHits("sponsorship")).toContain(`${orgBase}/programs`);
    expect(orgHits("webinar")).not.toContain(`${orgBase}/programs`);
    expect(orgHits("classes")).not.toContain(`${orgBase}/programs`);
    expect(orgHits("ebooks")).not.toContain(`${orgBase}/library`);
    expect(orgHits("templates")).not.toContain(`${orgBase}/library`);
    expect(orgHits("products")).not.toContain(`${orgBase}/library`);
    expect(orgHits("recordings")).toContain(`${orgBase}/library`);

    const expert = buildFindIndex({ nav: buildConsultantNav("cp-1") });
    const hits = (q: string) => filterFind(expert, q).map((e) => e.href);
    const base = "/dashboard/consultant/cp-1";
    expect(hits("webinar")).toContain(`${base}/sell/programs`);
    expect(hits("ebooks")).toContain(`${base}/products`);
    expect(hits("replays")).not.toContain(`${base}/products`);
    expect(hits("referrals")).toEqual([`${base}/referrals`]);
    expect(hits("ratings")).toEqual([`${base}/reviews`]);
    const groupOf = (q: string) => filterFind(expert, q).map((e) => e.group);
    expect(groupOf("referrals")).toEqual(["Money"]);
    expect(groupOf("ratings")).toEqual(["Reputation"]);
  });
});
