import type { MemberRole } from "@prisma/client";
import {
  BarChart3,
  Briefcase,
  CalendarCheck,
  ClipboardCheck,
  ClipboardList,
  CreditCard,
  FileText,
  GraduationCap,
  Handshake,
  Home,
  Library,
  LifeBuoy,
  MessageSquare,
  Settings,
  ShieldCheck,
  UserCog,
  Users,
  Video,
  Wallet,
} from "lucide-react";

import { hasOrgPermission, type OrgSurface } from "@/lib/auth/org-permissions";

import {
  flattenNav,
  type DashboardNav,
  type NavGroup,
  type NavItem,
} from "./types";

export interface OrganizationNavInput {
  orgId: string;
  role: MemberRole;
  canSponsor: boolean;
  canHost: boolean;
  /** Set when this member also delivers sessions (gates Requests). */
  consultantProfileId: string | null;
}

type ItemSpec = NavItem & { show?: boolean };

const keep = (items: ItemSpec[]): NavItem[] =>
  items
    .filter((it) => it.show !== false)
    .map(({ show: _show, ...rest }) => rest);

/**
 * Permission-filtered org IA (#1527 Q7), a pure builder so tests can walk every
 * role × capability × funding combination. Visibility comes from
 * `org-permissions.ts` — the same matrix page guards and API routes check —
 * ANDed with the structural capability gates. The sidebar is cosmetic; guards
 * stay server-side. POs, disputes and member spend are Billing tabs; materials
 * and operator collaborators are Catalog tabs (Q7).
 */
export function buildOrganizationNav(
  input: OrganizationNavInput,
): DashboardNav {
  const { orgId, role, canSponsor, canHost } = input;
  const can = (surface: OrgSurface) => hasOrgPermission(role, surface);
  const isExpertHost = can("myArrangement.read") && canHost;

  const top: ItemSpec[] = [
    { name: "Overview", icon: Home, path: "home" },
    {
      name: "My Program",
      icon: GraduationCap,
      path: "my-program",
      show: can("myProgram.read") && canSponsor,
    },
    {
      name: "Compensation",
      icon: UserCog,
      path: "compensation",
      show: isExpertHost,
    },
    // Any ACTIVE member: learners attend and experts deliver org sessions.
    { name: "Appointments", icon: CalendarCheck, path: "appointments" },
    // Org-scoped by route; Stream only returns channels the viewer is in.
    { name: "Messages", icon: MessageSquare, path: "messages" },
    {
      // The profile is the real predicate: an OWNER who delivers gets it too.
      name: "Requests",
      icon: ClipboardCheck,
      path: "requests",
      show:
        (can("myArrangement.read") || input.consultantProfileId !== null) &&
        canHost,
    },
    {
      // #1527-4c — experts keep it in Top; operators use Catalog › Collaborators.
      name: "Plan collaborators",
      icon: Handshake,
      path: "collaborations",
      show: isExpertHost,
    },
  ];

  const people: ItemSpec[] = [
    {
      name: "Members",
      icon: Users,
      path: "members",
      show: can("members.read"),
    },
  ];

  const sponsorship: ItemSpec[] = [
    {
      name: "Programs",
      icon: Briefcase,
      path: "programs",
      show: canSponsor && can("programs.manage"),
    },
    {
      name: "Contracts",
      icon: FileText,
      path: "contracts",
      show: canSponsor && can("contracts.read"),
    },
  ];

  const hosting: ItemSpec[] = [
    {
      name: "Catalog",
      icon: Library,
      path: "catalog",
      show: canHost && can("catalog.manage"),
    },
  ];

  const money: ItemSpec[] = [
    {
      name: "Billing",
      icon: CreditCard,
      path: "billing",
      show: canSponsor && can("billing.read"),
    },
    {
      name: "Payouts",
      icon: Wallet,
      path: "payouts",
      show: canHost && can("payouts.read"),
    },
  ];

  const operations: ItemSpec[] = [
    {
      // Metadata-only triage (ADR 20), never transcripts.
      name: "Support",
      icon: LifeBuoy,
      path: "support",
      show: can("operations.read"),
    },
    {
      name: "Documents",
      icon: FileText,
      path: "documents",
      show: can("operations.read"),
    },
    {
      name: "Recordings",
      icon: Video,
      path: "recordings",
      show: can("operations.read"),
    },
  ];

  const insights: ItemSpec[] = [
    {
      name: "Analytics",
      icon: BarChart3,
      path: "analytics",
      show: can("operations.read"),
    },
    {
      name: "Audit",
      icon: ClipboardList,
      path: "audit",
      show: can("audit.read"),
    },
    {
      name: "Consent",
      icon: ShieldCheck,
      path: "consent",
      show: can("consent.read"),
    },
  ];

  // "Hosting", not "Catalog": a group must not restate its only item.
  const groups: NavGroup[] = [
    { items: keep(top) },
    { label: "People", items: keep(people) },
    { label: "Sponsorship", items: keep(sponsorship) },
    { label: "Hosting", items: keep(hosting) },
    { label: "Money", items: keep(money) },
    {
      label: "Operations",
      items: keep(operations),
      // Document triage isn't an OWNER/MAINTAINER's daily job.
      defaultCollapsed: role === "OWNER" || role === "MAINTAINER",
    },
    { label: "Insights", items: keep(insights) },
  ].filter((g) => g.items.length > 0);

  // Ungated (ADR 23): the page floors at active membership and each tab
  // carries its own gate, so members reach their Notifications tab.
  const utility: NavItem[] = [
    { name: "Settings", icon: Settings, path: "settings" },
  ];

  return {
    basePath: `/dashboard/organization/${orgId}`,
    groups,
    utility,
    mobileTabs: organizationMobileTabs(groups),
  };
}

/**
 * Operators get Overview · Appointments · Members · Billing|Payouts; members
 * get their own landing · Appointments · Messages (#1527 §7.3).
 */
function organizationMobileTabs(groups: NavGroup[]): string[] {
  const paths = new Set(groups.flatMap((g) => g.items.map((i) => i.path)));
  const has = (p: string) => paths.has(p);
  let money: string | null = null;
  if (has("billing")) money = "billing";
  else if (has("payouts")) money = "payouts";

  if (has("members") || money) {
    return ["home", "appointments", has("members") ? "members" : null, money]
      .filter((p): p is string => p !== null)
      .slice(0, 4);
  }
  let landing = "home";
  if (has("my-program")) landing = "my-program";
  else if (has("compensation")) landing = "compensation";
  return [landing, "appointments", "messages"];
}

export const ORGANIZATION_PAGE_LABELS: Record<string, string> = {
  home: "Overview",
  "my-program": "My Program",
  compensation: "Compensation",
  collaborations: "Plan collaborators",
  appointments: "Appointments",
  messages: "Messages",
  requests: "Requests",
  members: "Members",
  catalog: "Catalog",
  materials: "Materials",
  programs: "Programs",
  contracts: "Contracts",
  documents: "Documents",
  recordings: "Recordings",
  support: "Support",
  billing: "Billing",
  payouts: "Payouts",
  analytics: "Analytics",
  audit: "Audit",
  consent: "Consent",
  settings: "Settings",
  new: "New",
  edit: "Edit",
};

/**
 * #1762-11 — true when `href` lands on an org page this viewer's nav offers,
 * so Home's CTAs never point at a page that would bounce them. Settings is
 * always reachable (its tabs gate themselves, ADR 23).
 */
export function canOpenOrgPage(
  input: Omit<OrganizationNavInput, "orgId">,
  href: string,
): boolean {
  const match = /\/dashboard\/organization\/[^/?#]+\/([^/?#]+)/.exec(href);
  if (!match) return true;
  const nav = buildOrganizationNav({ ...input, orgId: "_" });
  return flattenNav(nav).some((item) => item.path === match[1]);
}
