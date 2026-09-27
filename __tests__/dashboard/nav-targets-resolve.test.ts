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
import { canOpenOrgSettings } from "@/lib/dashboard/org-settings-sections";

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
    expect(nav.mobileTabs).toHaveLength(4);
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

  it("header CTAs and Help targets point at real pages", () => {
    expect(buildConsultantNav("cp-1").pinnedCta?.href).toBe(
      "/explore/experts/cp-1",
    );
    expect(
      existsSync(
        join(process.cwd(), "app/explore/experts/[consultantId]/page.tsx"),
      ),
    ).toBe(true);
    expect(buildConsulteeNav("ce-1").pinnedCta?.href).toBe("/explore/experts");
    // #1527 — the header Help menu's Support requests rows are the viewer's
    // own page; the back office has only the public Help Center.
    expect(
      buildBackofficeDashboardNav(backofficeCap("admin")).support,
    ).toBeNull();
    expect(buildWorkspaceNav("ow-1").support?.feedbackHref).toBeNull();
    const helpPages = [
      buildConsultantNav("cp-1").support?.requestsHref,
      buildConsulteeNav("ce-1").support?.requestsHref,
      buildWorkspaceNav("ow-1").support?.requestsHref,
      "/support",
    ].map((href) =>
      (href ?? "")
        .replace(
          "/dashboard/consultant/cp-1",
          "dashboard/consultant/[consultantId]/(features)",
        )
        .replace(
          "/dashboard/consultee/ce-1",
          "dashboard/consultee/[consulteeId]/(features)",
        )
        .replace(
          "/dashboard/org-workspace/ow-1",
          "dashboard/org-workspace/[orgWorkspaceId]",
        )
        .replace(/^\/support$/, "support"),
    );
    for (const dir of helpPages) {
      expect(existsSync(join(process.cwd(), "app", dir, "page.tsx"))).toBe(
        true,
      );
    }
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

  // Was 20 across six groups (#1527 Q7).
  it("a hybrid OWNER who delivers gets the consolidated IA", () => {
    const nav = buildOrganizationNav({
      orgId: "org-1",
      role: "OWNER",
      canSponsor: true,
      canHost: true,
      consultantProfileId: "cp-1",
    });
    expect(flattenNav(nav).length).toBeLessThanOrEqual(17);
    expect(nav.mobileTabs).toEqual([
      "home",
      "appointments",
      "members",
      "billing",
    ]);
  });
});

/**
 * #1527 role matrix — the org nav each role gets on a sponsor + host org,
 * walked from the same matrix the page gates and API guards read.
 */
describe("org nav role walk (#1527 matrix)", () => {
  const OPS = ["support", "analytics"];
  // #1527 — Library (Documents · Recordings) is every member's.
  const BASE = [
    "home",
    "appointments",
    "messages",
    "members",
    "documents",
    "recordings",
  ];
  const EXPECTED: Record<MemberRole, string[]> = {
    OWNER: [
      ...BASE,
      "programs",
      "contracts",
      "catalog",
      "billing",
      "payouts",
      ...OPS,
      "audit",
      "consent",
    ],
    MAINTAINER: [
      ...BASE,
      "programs",
      "contracts",
      "catalog",
      "billing",
      "payouts",
      ...OPS,
      "audit",
      "consent",
    ],
    // Finance track: no operations, catalog or consent; contracts + programs
    // read; Support for org-tagged requests (#1527).
    BILLING_ADMIN: [
      ...BASE,
      "programs",
      "contracts",
      "billing",
      "payouts",
      "support",
      "audit",
    ],
    // Decision 1 (no Payouts) and no Contracts; programs for seat assignment.
    MANAGER: [
      ...BASE,
      "programs",
      "catalog",
      "billing",
      ...OPS,
      "audit",
      "consent",
    ],
    SUPPORT: [...BASE, ...OPS, "audit"],
    EXPERT: [...BASE, "compensation", "collaborations"],
    LEARNER: [...BASE, "my-program"],
  };

  it.each(Object.keys(EXPECTED) as MemberRole[])("%s", (role) => {
    const nav = buildOrganizationNav({
      orgId: "org-1",
      role,
      canSponsor: true,
      canHost: true,
      consultantProfileId: null,
    });
    expect(
      flattenNav(nav)
        .map((i) => i.path)
        .sort(),
    ).toEqual([...EXPECTED[role]].sort());
  });

  it("Requests follows the page's own predicate: a consultant profile", () => {
    const paths = (consultantProfileId: string | null) =>
      flattenNav(
        buildOrganizationNav({
          orgId: "org-1",
          role: "EXPERT",
          canSponsor: false,
          canHost: true,
          consultantProfileId,
        }),
      ).map((i) => i.path);
    expect(paths(null)).not.toContain("requests");
    expect(paths("cp-1")).toContain("requests");
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

// #1527 — Settings: the avatar menu (+ mobile sheet) everywhere. Personal and
// back office carry it as `nav.settings`; the org and workspace entries come
// from the shell's account props, so their navs hold no settings row at all.
describe("where Settings lives", () => {
  const inGroups = (nav: DashboardNav) =>
    nav.groups.flatMap((g) => g.items).some((i) => i.path === "settings");

  it.each([
    ["consultant", buildConsultantNav("cp-1")],
    ["consultee", buildConsulteeNav("ce-1")],
    ["admin", buildBackofficeDashboardNav(backofficeCap("admin"))],
  ] as const)("%s: account Settings, never a rail row", (_name, nav) => {
    expect(nav.settings?.name).toBe("Settings");
    expect(inGroups(nav)).toBe(false);
  });

  it.each([
    [
      "organization",
      buildOrganizationNav({
        orgId: "org-1",
        role: "OWNER",
        canSponsor: true,
        canHost: true,
        consultantProfileId: null,
      }),
    ],
    ["workspace", buildWorkspaceNav("ow-1")],
  ] as const)("%s: no settings row in the rail", (_name, nav) => {
    expect(nav.settings).toBeUndefined();
    expect(inGroups(nav)).toBe(false);
  });

  it("the avatar menu's org entry follows the settings sections", () => {
    const roles: MemberRole[] = [
      "OWNER",
      "MAINTAINER",
      "BILLING_ADMIN",
      "MANAGER",
      "SUPPORT",
      "EXPERT",
      "LEARNER",
    ];
    expect(roles.filter(canOpenOrgSettings)).toEqual([
      "OWNER",
      "MAINTAINER",
      "BILLING_ADMIN",
    ]);
  });
});
