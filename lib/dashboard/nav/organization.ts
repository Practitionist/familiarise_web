import type { FundingSource, MemberRole } from "@prisma/client";
import {
  BarChart3,
  Briefcase,
  CalendarCheck,
  ClipboardCheck,
  ClipboardList,
  CreditCard,
  FileText,
  GraduationCap,
  Home,
  Library,
  LifeBuoy,
  MessageSquare,
  Receipt,
  Settings,
  ShieldAlert,
  ShieldCheck,
  UserCog,
  Users,
  Video,
  Wallet,
} from "lucide-react";

import { hasOrgPermission, type OrgSurface } from "@/lib/auth/org-permissions";

import type { DashboardNav, NavGroup, NavItem } from "./types";

export interface OrganizationNavInput {
  orgId: string;
  role: MemberRole;
  canSponsor: boolean;
  canHost: boolean;
  fundingSource: FundingSource | null;
  requiresPO: boolean;
  /** Set when this member also delivers sessions (gates Requests). */
  consultantProfileId: string | null;
}

type ItemSpec = NavItem & { show?: boolean };

const keep = (items: ItemSpec[]): NavItem[] =>
  items
    .filter((it) => it.show !== false)
    .map(({ show: _show, ...rest }) => rest);

/**
 * Today's permission-filtered org IA, lifted out of OrgDashboardShell so tests
 * can walk every role × capability × funding combination (#1527). Visibility
 * comes from `org-permissions.ts` — the same matrix page guards and API routes
 * check — ANDed with the structural capability gates. The sidebar is cosmetic;
 * guards stay server-side.
 */
export function buildOrganizationNav(
  input: OrganizationNavInput,
): DashboardNav {
  const { orgId, role, canSponsor, canHost, fundingSource, requiresPO } = input;
  const can = (surface: OrgSurface) => hasOrgPermission(role, surface);

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
      show: can("myArrangement.read") && canHost,
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
  ];

  const people: ItemSpec[] = [
    {
      name: "Members",
      icon: Users,
      path: "members",
      show: can("members.read"),
    },
    {
      name: "Collaborations",
      icon: Users,
      path: "collaborations",
      show: can("myArrangement.read") && canHost,
    },
  ];

  const commerce: ItemSpec[] = [
    {
      name: "Contracts",
      icon: FileText,
      path: "contracts",
      show: canSponsor && can("contracts.read"),
    },
    {
      // Only orgs running India AP 3-way-match need POs in the primary nav.
      name: "Purchase Orders",
      icon: Receipt,
      path: "purchase-orders",
      show: canSponsor && requiresPO && can("purchaseOrders.read"),
    },
    {
      name: "Catalog",
      icon: Library,
      path: "catalog",
      show: canHost && can("catalog.manage"),
    },
    {
      name: "Programs",
      icon: Briefcase,
      path: "programs",
      show: canSponsor && can("programs.manage"),
    },
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
    {
      name: "Reimbursements",
      icon: Wallet,
      path: "reimbursements",
      show:
        canSponsor &&
        fundingSource === "PERSONAL" &&
        can("reimbursements.read"),
    },
    {
      name: "Disputes",
      icon: ShieldAlert,
      path: "disputes",
      show: can("disputes.read"),
    },
  ];

  const resources: ItemSpec[] = [
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
    {
      // Metadata-only triage (ADR 20), never transcripts.
      name: "Support",
      icon: LifeBuoy,
      path: "support",
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

  // Ungated (ADR 23): the page floors at active membership and each tab
  // carries its own gate, so members reach their Notifications tab.
  const configuration: ItemSpec[] = [
    { name: "Settings", icon: Settings, path: "settings" },
  ];

  const groups: NavGroup[] = [
    { items: keep(top) },
    { label: "People", items: keep(people) },
    { label: "Commerce", items: keep(commerce) },
    {
      label: "Resources",
      items: keep(resources),
      // Document triage isn't an OWNER/MAINTAINER's daily job.
      defaultCollapsed: role === "OWNER" || role === "MAINTAINER",
    },
    { label: "Insights", items: keep(insights) },
    { label: "Configuration", items: keep(configuration) },
  ].filter((g) => g.items.length > 0);

  return {
    basePath: `/dashboard/organization/${orgId}`,
    groups,
    utility: [],
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
  collaborations: "Collaborations",
  appointments: "Appointments",
  messages: "Messages",
  requests: "Requests",
  members: "Members",
  catalog: "Catalog",
  materials: "Materials",
  programs: "Programs",
  contracts: "Contracts",
  "purchase-orders": "Purchase Orders",
  documents: "Documents",
  recordings: "Recordings",
  support: "Support",
  billing: "Billing",
  payouts: "Payouts",
  reimbursements: "Reimbursements",
  disputes: "Disputes",
  analytics: "Analytics",
  audit: "Audit",
  consent: "Consent",
  settings: "Settings",
  new: "New",
  edit: "Edit",
};
