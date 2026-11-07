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
  LayoutGrid,
  Library,
  LifeBuoy,
  MessageSquare,
  ShieldCheck,
  UserCog,
  Users,
  Wallet,
} from "lucide-react";

import { hasOrgPermission, type OrgSurface } from "@/lib/auth/org-permissions";
import { canOpenOrgSettings } from "@/lib/dashboard/org-settings-sections";

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
  /**
   * #1527 decision 6 — a SUSPENDED membership keeps Overview, its booked
   * sessions and their Library files; every other page refuses it server-side.
   */
  suspended?: boolean;
}

type ItemSpec = NavItem & { show?: boolean };

/**
 * The Compensation / Collaborations (own plans) page gate: the EXPERT role, or
 * any member holding a consultant profile (an OWNER can deliver too). Every
 * member the nav offers those pages to passes it.
 */
export function deliversForOrg(
  input: Pick<OrganizationNavInput, "role" | "consultantProfileId">,
): boolean {
  return (
    hasOrgPermission(input.role, "myArrangement.read") ||
    input.consultantProfileId !== null
  );
}

const keep = (items: ItemSpec[]): NavItem[] =>
  items
    .filter((it) => it.show !== false)
    .map(({ show: _show, ...rest }) => rest);

/**
 * Permission-filtered org IA, a pure builder so tests can walk every role ×
 * capability combination. Visibility comes from `org-permissions.ts` — the
 * same matrix page guards and API routes check — ANDed with the structural
 * capability gates. The sidebar is cosmetic; guards stay server-side.
 */
export function buildOrganizationNav(
  input: OrganizationNavInput,
): DashboardNav {
  const { orgId, role, canSponsor, canHost } = input;
  // Every member's own session files (Mine); operations.read adds the
  // Everyone scope inside, so the item itself is ungated.
  const library: NavGroup = {
    items: [{ name: "Library", icon: Library, path: "library" }],
  };
  if (input.suspended) {
    return {
      basePath: `/dashboard/organization/${orgId}`,
      groups: [
        {
          items: [
            { name: "Overview", icon: Home, path: "home" },
            { name: "Appointments", icon: CalendarCheck, path: "appointments" },
          ],
        },
        library,
      ],
      support: null,
      mobileTabs: ["home", "appointments"],
    };
  }
  const can = (surface: OrgSurface) => hasOrgPermission(role, surface);
  // Nav ⊆ page: the Compensation / Collaborations pages admit anyone who
  // `deliversForOrg`; the nav offers them to experts only.
  const isExpertHost = can("myArrangement.read") && canHost;
  // One Collaborations route: operators read every hosted plan from the Host
  // group, experts their own from My work. Never both for one viewer.
  const operatorCollaborations = canHost && can("catalog.manage");

  // Member-shaped: each item is gated, so most members see two or three.
  const myWork: ItemSpec[] = [
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
    {
      // The profile is the real predicate: an OWNER who delivers gets it too.
      // Same test as the page, which redirects without a profile (#1527 P1-10).
      name: "Booking requests",
      icon: ClipboardCheck,
      path: "requests",
      show: input.consultantProfileId !== null && canHost,
    },
    {
      name: "Collaborations",
      icon: Handshake,
      path: "collaborations",
      show: isExpertHost && !operatorCollaborations,
    },
  ];

  const people: ItemSpec[] = [
    {
      // Every member gets the names-only directory; members.read gets the
      // full table inside (#1527 decision 3).
      name: "Members",
      icon: Users,
      path: "members",
      show: can("members.directory"),
    },
  ];

  const sponsor: ItemSpec[] = [
    {
      name: "Sponsorship programs",
      icon: Briefcase,
      path: "programs",
      show: canSponsor && can("programs.read"),
    },
    {
      name: "Contracts",
      icon: FileText,
      path: "contracts",
      show: canSponsor && can("contracts.read"),
    },
    {
      name: "Billing",
      icon: CreditCard,
      path: "billing",
      show: canSponsor && can("billing.read"),
    },
  ];

  const host: ItemSpec[] = [
    {
      name: "Catalog",
      icon: LayoutGrid,
      path: "catalog",
      show: canHost && can("catalog.manage"),
    },
    {
      name: "Collaborations",
      icon: Handshake,
      path: "collaborations",
      show: operatorCollaborations,
    },
    {
      name: "Payouts",
      icon: Wallet,
      path: "payouts",
      show: canHost && can("payouts.read"),
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

  const groups: NavGroup[] = [
    { items: [{ name: "Overview", icon: Home, path: "home" }] },
    { label: "My work", items: keep(myWork) },
    // Org-scoped by route; Stream only returns channels the viewer is in.
    { items: [{ name: "Messages", icon: MessageSquare, path: "messages" }] },
    library,
    { label: "People", items: keep(people) },
    { label: "Sponsor", items: keep(sponsor) },
    { label: "Host", items: keep(host) },
    { label: "Insights", items: keep(insights) },
    {
      // Org triage (metadata only) and org-tagged cases; each tab carries its
      // own gate. The Help menu's personal row reads "My support cases".
      items: [{ name: "Help & support", icon: LifeBuoy, path: "support" }],
    },
  ].filter((g) => g.items.length > 0);
  return {
    basePath: `/dashboard/organization/${orgId}`,
    groups,
    // The org's own `support` is operator triage (operations.read), not the
    // viewer's requests; the shell fills in their personal page (#1527).
    support: null,
    mobileTabs: organizationMobileTabs(groups, role),
  };
}

/**
 * Operators get Overview · Appointments · Members · Billing|Payouts; members
 * get their own landing · Appointments · Messages (#1527 §7.3).
 */
function organizationMobileTabs(
  groups: NavGroup[],
  role: MemberRole,
): string[] {
  const paths = new Set(groups.flatMap((g) => g.items.map((i) => i.path)));
  const has = (p: string) => paths.has(p);
  let money: string | null = null;
  if (has("billing")) money = "billing";
  else if (has("payouts")) money = "payouts";
  // Members is in every nav now (the directory); the operator layout keys on
  // the full roster grant instead (#1527).
  const operatorMembers =
    has("members") && hasOrgPermission(role, "members.read");

  if (operatorMembers || money) {
    return ["home", "appointments", operatorMembers ? "members" : null, money]
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
  requests: "Booking requests",
  members: "Members",
  catalog: "Catalog",
  programs: "Sponsorship programs",
  contracts: "Contracts",
  library: "Library",
  documents: "Session documents",
  recordings: "Session recordings",
  support: "Help & support",
  evidence: "Evidence requests",
  activity: "Member support activity",
  billing: "Billing",
  payouts: "Payouts",
  analytics: "Analytics",
  audit: "Audit",
  consent: "Consent",
  settings: "Organization settings",
  general: "General",
  branding: "Branding",
  sso: "Domains & SSO",
  webhooks: "Webhooks",
  "data-exports": "Data exports",
  new: "New",
};

/**
 * #1762-11 — true when `href` lands on an org page this viewer's nav offers,
 * so Home's CTAs never point at a page that would bounce them. Settings is
 * in the avatar menu and mobile Menu, not the rail: it opens when the role holds any settings section.
 */
export function canOpenOrgPage(
  input: Omit<OrganizationNavInput, "orgId">,
  href: string,
): boolean {
  const match = /\/dashboard\/organization\/[^/?#]+\/([^/?#]+)/.exec(href);
  if (!match) return true;
  if (match[1] === "settings") {
    return !input.suspended && canOpenOrgSettings(input.role);
  }
  const nav = buildOrganizationNav({ ...input, orgId: "_" });
  return flattenNav(nav).some((item) => item.path === match[1]);
}
