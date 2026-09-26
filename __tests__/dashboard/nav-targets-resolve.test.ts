/**
 * Every sidebar item must point at a route that actually has a page.
 *
 * This exists because the IA consolidation broke exactly that invariant: the
 * org settings route was renamed `page.tsx` → `GeneralPanel.tsx` to become a
 * tab, and the replacement `page.tsx` was never created. The sidebar kept
 * rendering "Settings", and every org role got a 404 on click. tsc and the
 * other tests were happy, so a filesystem check is the only guard.
 *
 * #1527: the navs are pure builders now, so this imports them and walks every
 * combination instead of regex-scanning layout source.
 */

import { existsSync } from "fs";
import { join } from "path";
import type { MemberRole } from "@prisma/client";

import { buildBackofficeNav } from "@/lib/dashboard/backoffice-nav";
import { findMoneyTab } from "@/lib/backoffice/money-tabs";
import {
  resolveBackofficeCapability,
  type BackofficeTree,
} from "@/lib/backoffice/capability";
import { buildBackofficeDashboardNav } from "@/lib/dashboard/nav/backoffice";
import { buildConsultantNav } from "@/lib/dashboard/nav/consultant";
import { buildConsulteeNav } from "@/lib/dashboard/nav/consultee";
import { buildOrganizationNav } from "@/lib/dashboard/nav/organization";
import { buildWorkspaceNav } from "@/lib/dashboard/nav/workspace";
import { flattenNav, type DashboardNav } from "@/lib/dashboard/nav/types";

const APP = join(process.cwd(), "app/dashboard");

/** A route resolves if any of its candidate segment dirs has a page.tsx. */
function resolves(...candidates: string[]): boolean {
  return candidates.some((c) => existsSync(join(APP, c, "page.tsx")));
}

/** A money section resolves through the shared `money/[tab]` page, if known. */
function moneyTarget(path: string): string {
  const key = path.replace(/^money\//, "");
  return path.startsWith("money/") && findMoneyTab(key) ? "money/[tab]" : path;
}

/** Nav paths whose page is missing under any of the given route dirs. */
function missingPaths(nav: DashboardNav, ...routeDirs: string[]): string[] {
  return flattenNav(nav)
    .map((item) => moneyTarget(item.path))
    .filter((p) => !resolves(...routeDirs.map((dir) => `${dir}/${p}`)));
}

/** Mobile tabs must be nav items (label + icon come from them), ≤ 4. */
function expectTabsAreItems(nav: DashboardNav) {
  const paths = new Set(flattenNav(nav).map((i) => i.path));
  expect(nav.mobileTabs.length).toBeLessThanOrEqual(4);
  expect(nav.mobileTabs.filter((p) => !paths.has(p))).toEqual([]);
}

const backofficeCap = (tree: BackofficeTree) =>
  resolveBackofficeCapability(tree === "admin" ? "ADMIN" : "STAFF", tree)!;

describe("back-office nav targets resolve", () => {
  it.each(["admin", "staff"] as const)("%s tree", (tree) => {
    const nav = buildBackofficeDashboardNav(backofficeCap(tree), {
      showTds: true,
    });
    expect(flattenNav(nav).length).toBeGreaterThan(0);
    // #1527 Q3 — one route tree serves both.
    expect(missingPaths(nav, "(backoffice)/[tree]")).toEqual([]);
    expectTabsAreItems(nav);
    expect(nav.mobileTabs.length).toBe(4);
  });
});

describe("personal + workspace nav targets resolve", () => {
  it.each([
    [
      "consultant",
      buildConsultantNav("cp-1"),
      "consultant/[consultantId]/(features)",
    ],
    [
      "consultee",
      buildConsulteeNav("ce-1"),
      "consultee/[consulteeId]/(features)",
    ],
    [
      "org-workspace",
      buildWorkspaceNav("ow-1"),
      "org-workspace/[orgWorkspaceId]",
    ],
    // #1527 §7.4 — Activity and Spend hide at one owned org.
    [
      "org-workspace (one org)",
      buildWorkspaceNav("ow-1", { ownedOrgCount: 1 }),
      "org-workspace/[orgWorkspaceId]",
    ],
  ] as const)("%s", (_name, nav, routeDir) => {
    expect(missingPaths(nav, routeDir)).toEqual([]);
    expectTabsAreItems(nav);
  });

  it("pinned CTAs point at real public pages", () => {
    expect(buildConsultantNav("cp-1").pinnedCta?.href).toBe(
      "/explore/experts/cp-1",
    );
    expect(
      existsSync(
        join(process.cwd(), "app/explore/experts/[consultantId]/page.tsx"),
      ),
    ).toBe(true);
    expect(buildConsulteeNav("ce-1").pinnedCta?.href).toBe("/explore/experts");
  });
});

describe("org nav targets resolve for every role × capability", () => {
  const ROLES: MemberRole[] = [
    "OWNER",
    "MAINTAINER",
    "BILLING_ADMIN",
    "MANAGER",
    "EXPERT",
    "LEARNER",
    "SUPPORT",
  ];
  const CAPABILITIES = {
    SPONSOR: { canSponsor: true, canHost: false },
    HOST: { canSponsor: false, canHost: true },
    HYBRID: { canSponsor: true, canHost: true },
    INERT: { canSponsor: false, canHost: false },
  } as const;
  // #1527 Q7 — funding-shaped money pages are Billing tabs, not nav items.
  const RETIRED = [
    "purchase-orders",
    "disputes",
    "reimbursements",
    "materials",
  ];

  const cases = ROLES.flatMap((role) =>
    Object.entries(CAPABILITIES).flatMap(([kind, caps]) =>
      [false, true].map((delivers) => [role, kind, delivers, caps] as const),
    ),
  );

  it.each(cases)("%s · %s · delivers=%s", (role, _kind, delivers, caps) => {
    const nav = buildOrganizationNav({
      orgId: "org-1",
      role,
      ...caps,
      consultantProfileId: delivers ? "cp-1" : null,
    });
    expect(missingPaths(nav, "organization/[orgId]")).toEqual([]);
    expectTabsAreItems(nav);
    const paths = flattenNav(nav).map((i) => i.path);
    expect(paths.filter((p) => RETIRED.includes(p))).toEqual([]);
    // Members always get more than Overview + Settings on a phone (#1527 §1).
    expect(nav.mobileTabs.length).toBeGreaterThanOrEqual(3);
  });

  // Was 20 across six groups; Operations starts collapsed for OWNER, so
  // about 14 show on first paint.
  it("a hybrid OWNER who delivers gets the consolidated IA", () => {
    const nav = buildOrganizationNav({
      orgId: "org-1",
      role: "OWNER",
      canSponsor: true,
      canHost: true,
      consultantProfileId: "cp-1",
    });
    expect(flattenNav(nav).length).toBeLessThanOrEqual(17);
    expect(
      nav.groups.find((g) => g.label === "Operations")?.defaultCollapsed,
    ).toBe(true);
    expect(nav.mobileTabs).toEqual([
      "home",
      "appointments",
      "members",
      "billing",
    ]);
  });
});

/**
 * A group header that restates the only item beneath it carries no
 * information — the reader expands "Resources" to find "Resources". The rule:
 * a labelled group must hold more than one item, or an item named differently.
 */
describe("no redundant group nesting", () => {
  const navs: Array<[string, DashboardNav["groups"]]> = [
    ["admin", buildBackofficeNav(backofficeCap("admin"), { showTds: true })],
    ["staff", buildBackofficeNav(backofficeCap("staff"), { showTds: true })],
    ["consultant", buildConsultantNav("cp-1").groups],
    ["consultee", buildConsulteeNav("ce-1").groups],
    [
      "organization",
      buildOrganizationNav({
        orgId: "org-1",
        role: "OWNER",
        canSponsor: true,
        canHost: true,
        consultantProfileId: "cp-1",
      }).groups,
    ],
  ];

  it.each(navs)("%s groups never restate their only item", (_name, groups) => {
    const offenders = groups
      .filter(
        (g) => g.label && g.items.length === 1 && g.items[0].name === g.label,
      )
      .map((g) => g.label);
    expect(offenders).toEqual([]);
  });
});
