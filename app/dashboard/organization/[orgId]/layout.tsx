"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import React, { use, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Home,
  Users,
  Mail,
  GraduationCap,
  Briefcase,
  CreditCard,
  BarChart3,
  ClipboardList,
  Settings,
  Wallet,
  UserCog,
  Building2,
  LayoutDashboard,
  Clock,
  FileText,
  CalendarCheck,
  ListOrdered,
  Sparkles,
  Video,
  Receipt,
  ShieldCheck,
  Webhook,
  KeyRound,
  Download,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";

// Mobile bottom-tab configuration — 5 most-accessed org pages.
// Role gating happens at the API layer; the tabs are always visible so the
// user discovers what exists even before they have elevated permissions.
const MOBILE_TABS: {
  label: string;
  path: string;
  Icon: LucideIcon;
}[] = [
  { label: "Overview", path: "home", Icon: Home },
  { label: "Members", path: "members", Icon: Users },
  { label: "Billing", path: "billing", Icon: CreditCard },
  { label: "Analytics", path: "analytics", Icon: BarChart3 },
  { label: "Settings", path: "settings", Icon: Settings },
];

import {
  CollapsibleSidebar,
  CollapsibleSidebarSkeleton,
  type CollapsibleSidebarGroup,
} from "@/components/dashboard/CollapsibleSidebar";
import { OrgContextBar } from "@/components/dashboard/OrgContextBar";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { signOut, useSession } from "@/lib/auth-client";
import {
  isAtLeastRole,
  canSeeOperatorSurface,
  canSeeFinanceSurface,
} from "@/lib/auth/role-ranks";
import { MEMBER_ROLE_LABEL } from "@/lib/labels/org-labels";
import { resolvePersonalDashboardHref } from "@/lib/labels/personal-dashboard";
import { disconnectStreamClients } from "@/providers/StreamProvider";
import type { MemberRole, OrgStatus } from "@prisma/client";
import {
  fetchOrgDetails,
  orgDetailsQueryKey,
} from "@/lib/api/organizations/org-details";

/**
 * Banner rendered across the org dashboard when `Organization.status !== ACTIVE`.
 * A newly created org sits in PENDING_VERIFICATION until a platform admin
 * runs the verify action. OWNER can still configure branding, draft programs,
 * and explore the product — but invitations, wallet top-ups, and contracts
 * are paused server-side. The banner explains why the write surfaces are
 * returning 409 ORG_NOT_VERIFIED.
 */
function OrgStatusBanner({ status }: { status: OrgStatus }) {
  const copy: Record<OrgStatus, { title: string; body: string; tone: string } | null> = {
    PENDING_VERIFICATION: {
      title: "Awaiting platform review",
      body: "You can set up branding and draft programs now. Inviting members and moving money unlocks as soon as an admin verifies your organization.",
      tone: "bg-amber-50 border-amber-200 text-amber-900",
    },
    SUSPENDED: {
      title: "Organization suspended",
      body: "Invitations and payments are paused. Contact support to restore access.",
      tone: "bg-rose-50 border-rose-200 text-rose-900",
    },
    ACTIVE: null,
    DEACTIVATED: {
      title: "Organization deactivated",
      body: "This organization is no longer operational.",
      tone: "bg-zinc-100 border-zinc-300 text-zinc-800",
    },
  };
  const message = copy[status];
  if (!message) return null;
  return (
    <div
      className={`border-b px-4 sm:px-6 py-2.5 flex items-start gap-3 text-sm ${message.tone}`}
    >
      <Clock className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="flex-1">
        <span className="font-semibold">{message.title}.</span>{" "}
        <span>{message.body}</span>
      </div>
    </div>
  );
}

function AccessDenied({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex items-center justify-center min-h-screen bg-zinc-100">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white p-8 rounded-2xl shadow-xl border border-zinc-200 max-w-md text-center"
      >
        <h2 className="text-xl font-bold text-zinc-900 mb-2">{title}</h2>
        <p className="text-zinc-600">{message}</p>
        <Link
          href="/dashboard/organization"
          className="inline-block mt-6 px-6 py-2.5 bg-zinc-900 text-white rounded-lg font-medium hover:bg-zinc-800 transition-colors"
        >
          Back to organizations
        </Link>
      </motion.div>
    </div>
  );
}

export default function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, isPending: isSessionLoading } = useSession();

  const {
    data: org,
    error,
    isLoading,
  } = useQuery({
    queryKey: orgDetailsQueryKey(orgId),
    queryFn: () => fetchOrgDetails(orgId),
    enabled: !!orgId && !!session?.user?.id,
    staleTime: 60_000,
  });

  // Compute grouped sidebar items from capabilities + fundingSource + role.
  // The API layer enforces the same gates, but hiding what the user can't
  // act on keeps the sidebar tidy. Five clusters (People / Commerce /
  // Operations / Insights / Configuration) plus an ungrouped Overview
  // block. Each cluster's items get role-gated independently; groups
  // with zero remaining items drop out entirely.
  //
  // Role visibility decisions baked in here (see audit doc):
  //   - SUPPORT (rank 30) gets read access to Members + Operations +
  //     Audit + Analytics so L1/L2 can investigate tickets without
  //     escalating. Previously the layout's isAtLeast("MANAGER") gate
  //     denied SUPPORT every operational tab — a real bug.
  //   - OWNER's Operations group defaults collapsed. The OWNER has
  //     permission to drill in (rank 100 ≥ MANAGER 60) but the cluster
  //     is operational MANAGER/SUPPORT work — not part of the OWNER's
  //     primary nav. They can still expand it when they want to.
  //   - BILLING_ADMIN stays operator-blind (no Members/Invitations/
  //     People surfaces) — finance-only remit. Operations group is
  //     hidden for them entirely (no read need for booking-side data).
  const sidebarGroups: CollapsibleSidebarGroup[] = useMemo(() => {
    if (!org) return [];
    const { canSponsor, canHost, fundingSource, requiresPO } = org.organization;
    const role = org.membership.role;

    const isAtLeast = (min: MemberRole) => isAtLeastRole(role, min);
    const isOperator = canSeeOperatorSurface(role);
    const isFinance = canSeeFinanceSurface(role);
    const isSupport = role === "SUPPORT";

    // "Operational read" gate — MANAGER+ or SUPPORT. Used by
    // Operations + Members + Analytics + Audit. Encodes the L1/L2
    // support carve-out from the rank ladder.
    const isOperationsReader = isOperator && (isAtLeast("MANAGER") || isSupport);

    // Operations group defaults collapsed for OWNER + MAINTAINER —
    // their primary job isn't appointment-level data triage. Open by
    // default for MANAGER + SUPPORT who live in those tabs.
    const operationsCollapsedDefault =
      isOperator && (role === "OWNER" || role === "MAINTAINER");

    type ItemSpec = {
      name: string;
      icon: LucideIcon;
      path: string;
      show?: boolean;
    };

    // Top (no label) — Overview + consumer-role landing pages. The
    // LEARNER / EXPERT cases are the only sidebar items those roles
    // ever see. Operators (MANAGER+) get the richer per-tab views.
    const topItems: ItemSpec[] = [
      { name: "Overview", icon: Home, path: "home" },
      {
        name: "My Program",
        icon: GraduationCap,
        path: "my-program",
        show: role === "LEARNER" && canSponsor,
      },
      {
        name: "My Arrangement",
        icon: UserCog,
        path: "my-arrangement",
        show: role === "EXPERT" && canHost,
      },
    ];

    // People — governance + roster surfaces. Intentionally hidden for
    // BILLING_ADMIN. SUPPORT gets read access to Members for
    // ticket investigation (see isOperationsReader rationale above).
    const peopleItems: ItemSpec[] = [
      {
        name: "Members",
        icon: Users,
        path: "members",
        show: isOperationsReader,
      },
      {
        name: "Invitations",
        icon: Mail,
        path: "invitations",
        show: isOperator && isAtLeast("MAINTAINER"),
      },
      {
        name: "Learners",
        icon: GraduationCap,
        path: "learners",
        show: canSponsor && isOperator && isAtLeast("MANAGER"),
      },
      {
        name: "Experts",
        icon: UserCog,
        path: "experts",
        show: canHost && isOperator && isAtLeast("MANAGER"),
      },
    ];

    // Commerce — money + entitlement surfaces, ordered to match the
    // setup flow: Contract first (commercial frame), then optional PO
    // (India AP 3-way-match), then Programs (the entitlement the
    // contract authorizes), then Billing (the invoices that result).
    // Payouts + Reimbursements appear at the bottom for HOST orgs and
    // for SPONSOR+PERSONAL orgs respectively — they're money-OUT
    // outcomes, not setup. Mutation gates stay on the route handlers;
    // the sidebar entries are visibility-only.
    const commerceItems: ItemSpec[] = [
      {
        name: "Contracts",
        icon: FileText,
        path: "contracts",
        show: canSponsor && (isAtLeast("MAINTAINER") || isFinance),
      },
      {
        // Only orgs running India AP 3-way-match (requiresPO=true) need
        // the PO tab in their primary nav. The PO surface itself stays
        // reachable by URL for orgs that opt in later — this is sidebar
        // visibility, not authz. See docs/enterprise/12-dashboard-pages.md.
        name: "Purchase Orders",
        icon: Receipt,
        path: "purchase-orders",
        show:
          canSponsor &&
          requiresPO &&
          (isAtLeast("MAINTAINER") || isFinance),
      },
      {
        name: "Programs",
        icon: Briefcase,
        path: "programs",
        show: canSponsor && (isAtLeast("MAINTAINER") || isFinance),
      },
      {
        name: "Billing",
        icon: CreditCard,
        path: "billing",
        show: (canSponsor || fundingSource === "WALLET") && isFinance,
      },
      {
        name: "Payouts",
        icon: Wallet,
        path: "payouts",
        show: canHost && isFinance,
      },
      {
        name: "Reimbursements",
        icon: Wallet,
        path: "reimbursements",
        show: canSponsor && fundingSource === "PERSONAL" && isFinance,
      },
      {
        // #776 §C — per-org dispute/chargeback surface. Finance-only; the
        // money-path (org-wallet-first clawback) settles server-side.
        name: "Disputes",
        icon: ShieldAlert,
        path: "disputes",
        show: isFinance,
      },
    ];

    // Operations — booking-side data feeds. MANAGER + SUPPORT live
    // here. OWNER + MAINTAINER have access but the group is
    // collapsed by default (see operationsCollapsedDefault).
    // BILLING_ADMIN is excluded — no booking-side remit.
    const operationsItems: ItemSpec[] = [
      {
        name: "Appointments",
        icon: CalendarCheck,
        path: "appointments",
        show: isOperationsReader,
      },
      {
        name: "Waitlist",
        icon: ListOrdered,
        path: "waitlist",
        show: isOperationsReader,
      },
      {
        name: "Trials",
        icon: Sparkles,
        path: "trials",
        show: isOperationsReader,
      },
      {
        name: "Documents",
        icon: FileText,
        path: "documents",
        show: isOperationsReader,
      },
      {
        name: "Recordings",
        icon: Video,
        path: "recordings",
        show: isOperationsReader,
      },
    ];

    // Insights — analytics + compliance + audit trail. SUPPORT
    // gets Audit + Analytics for ticket investigation; the bulk
    // gate (`isOperationsReader`) covers both. Consent is MANAGER+
    // only (DPDP grant/withdraw is a governance surface).
    const insightsItems: ItemSpec[] = [
      {
        name: "Analytics",
        icon: BarChart3,
        path: "analytics",
        show: isOperationsReader,
      },
      {
        name: "Audit",
        icon: ClipboardList,
        path: "audit",
        show: isAtLeast("MAINTAINER") || isSupport,
      },
      {
        name: "Consent",
        icon: ShieldCheck,
        path: "consent",
        show: isOperator && isAtLeast("MANAGER"),
      },
    ];

    // Configuration — settings + outbound/inbound integrations.
    // Settings stays MAINTAINER+ (org-config is sensitive). Webhooks +
    // SCIM + Data exports are BILLING_ADMIN-reachable for finance
    // integrations.
    const configurationItems: ItemSpec[] = [
      {
        name: "Settings",
        icon: Settings,
        path: "settings",
        show: isAtLeast("MAINTAINER"),
      },
      {
        name: "Webhooks",
        icon: Webhook,
        path: "integrations/webhooks",
        show: isFinance,
      },
      {
        name: "SCIM",
        icon: KeyRound,
        path: "integrations/scim",
        show: isFinance,
      },
      {
        name: "Data exports",
        icon: Download,
        path: "integrations/data-exports",
        show: isFinance,
      },
    ];

    const filterItems = (items: ItemSpec[]) =>
      items
        .filter((it) => it.show !== false)
        .map(({ show: _show, ...rest }) => rest);

    const groups: CollapsibleSidebarGroup[] = [
      { items: filterItems(topItems) },
      { label: "People", items: filterItems(peopleItems) },
      { label: "Commerce", items: filterItems(commerceItems) },
      {
        label: "Operations",
        items: filterItems(operationsItems),
        defaultCollapsed: operationsCollapsedDefault,
      },
      { label: "Insights", items: filterItems(insightsItems) },
      { label: "Configuration", items: filterItems(configurationItems) },
    ];

    // Drop empty groups — e.g. a LEARNER's sidebar has nothing in
    // People/Commerce/Operations/Insights/Configuration after
    // filtering, so they see only the top "Overview + My Program"
    // block without ghost headers.
    return groups.filter((g) => g.items.length > 0);
  }, [org]);

  // Redirect to /home when landing on the bare /[orgId] route.
  useEffect(() => {
    if (org && pathname === `/dashboard/organization/${orgId}`) {
      router.replace(`/dashboard/organization/${orgId}/home`);
    }
  }, [org, pathname, orgId, router]);

  const handleSignOut = async () => {
    try {
      await disconnectStreamClients();
    } catch {
      // ignore
    }
    signOut({
      fetchOptions: {
        onSuccess: () => {
          window.location.href = "/auth/signin";
        },
      },
    });
  };

  if (!session?.user?.id && !isSessionLoading) {
    return (
      <AccessDenied
        title="Authentication Required"
        message="Please sign in to access the organization dashboard."
      />
    );
  }

  if ((isLoading || isSessionLoading) && !org) {
    return <CollapsibleSidebarSkeleton />;
  }

  if (error) {
    return (
      <AccessDenied
        title="Organization unavailable"
        message={
          error instanceof Error
            ? error.message
            : "We could not load this organization."
        }
      />
    );
  }

  // Split the context-switching surface across TWO dropdowns:
  //   - Top header (org identity)  → switch between orgs / personal dashboard
  //   - Bottom user chip (personal) → user identity + sign out
  // This mirrors the Linear / Agentstack pattern: the top answers "which
  // context am I in?", the bottom answers "who am I?".
  const userExt = session?.user as
    | (NonNullable<typeof session>["user"] & {
        orgWorkspaceProfileId?: string | null;
        consultantProfileId?: string | null;
        consulteeProfileId?: string | null;
        organizationMemberships?: Array<{
          organizationId: string;
          organizationName: string;
          organizationLogo: string | null;
          role: string;
        }>;
      })
    | undefined;

  const personalHref = resolvePersonalDashboardHref({
    orgWorkspaceProfileId: userExt?.orgWorkspaceProfileId,
    consultantProfileId: userExt?.consultantProfileId,
    consulteeProfileId: userExt?.consulteeProfileId,
  });

  // Other orgs the user belongs to (excluding the current one)
  const otherOrgs = (userExt?.organizationMemberships ?? []).filter(
    (m) => m.organizationId !== orgId,
  );

  // Bottom chip dropdown — context switching + account actions.
  // Top header stays static (org identity + collapse arrow). Single dropdown
  // at the bottom keeps the "which dropdown has what" confusion at zero.
  const settingsHref = `/dashboard/organization/${orgId}/settings`;

  const bottomUserChipActions: NonNullable<
    React.ComponentProps<typeof CollapsibleSidebar>["bottomUserChipActions"]
  > = [
    ...(personalHref
      ? [{
          type: "item" as const,
          label: "Personal Dashboard",
          href: personalHref,
          icon: LayoutDashboard,
        }]
      : []),
    ...(otherOrgs.length > 0
      ? [
          { type: "separator" as const },
          { type: "label" as const, label: "Switch organization" },
          ...otherOrgs.map((m) => ({
            type: "item" as const,
            label: m.organizationName,
            href: `/dashboard/organization/${m.organizationId}/home`,
            icon: Building2,
          })),
        ]
      : []),
    { type: "separator" },
    {
      type: "item",
      label: "Organization settings",
      href: settingsHref,
      icon: Settings,
    },
  ];

  // Subtitle under the org name: the user's role in THIS org. Capability
  // badges (Sponsor/Host/Hybrid) + funding source live in the top-bar —
  // sidebar subtitle is user-specific, top-bar badges are org-specific.
  const topSubtitle = org ? MEMBER_ROLE_LABEL[org.membership.role] : null;

  // Map URL segments to human-readable page names so the breadcrumbs match
  // the heading the user actually sees on the page.
  const PAGE_LABELS: Record<string, string> = {
    home:         "Overview",
    members:      "Members",
    invitations:  "Invitations",
    learners:     "Learners",
    experts:      "Experts",
    programs:     "Programs",
    contracts:    "Contracts",
    appointments: "Appointments",
    waitlist:     "Waitlist",
    trials:       "Trials",
    documents:    "Documents",
    recordings:   "Recordings",
    billing:      "Billing",
    payouts:      "Payouts",
    disputes:     "Disputes",
    analytics:    "Analytics",
    audit:        "Audit",
    settings:     "Settings",
    sso:          "SSO",
  };

  // Full breadcrumb trail — every URL segment after /organization/{orgId}
  // becomes a crumb. Forward-compatible with nested routes.
  const breadcrumbs = pathname
    .replace(`/dashboard/organization/${orgId}`, "")
    .split("/")
    .filter(Boolean)
    .map((seg) => PAGE_LABELS[seg] ?? seg);

  return (
    <div className="flex h-screen-maintenance bg-zinc-50 dark:bg-zinc-950">
      {/* Collapsible sidebar — hidden on mobile, visible on md+ */}
      <div className="hidden md:block shrink-0">
        <CollapsibleSidebar
          groups={sidebarGroups}
          basePath={`/dashboard/organization/${orgId}`}
          title={org?.organization.name ?? "Organization"}
          avatarFallback={(org?.organization.name ?? "O")
            .charAt(0)
            .toUpperCase()}
          userName={org?.organization.name}
          userImage={org?.organization.logo}
          userSubtitle={topSubtitle}
          bottomUserChipActions={bottomUserChipActions}
          bottomUserChip={
            session?.user
              ? {
                  name: session.user.name ?? null,
                  image: session.user.image ?? null,
                  role: org?.membership.role ?? "",
                }
              : undefined
          }
          pathname={pathname}
          onSignOut={handleSignOut}
        />
      </div>

      {/* Right panel: context bar + page content */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Sticky context bar — always shows org identity + back link */}
        {org && (
          <OrgContextBar
            orgName={org.organization.name}
            orgLogo={org.organization.logo}
            canSponsor={org.organization.canSponsor}
            canHost={org.organization.canHost}
            fundingSource={org.organization.fundingSource}
            breadcrumbs={breadcrumbs}
            personalHref={personalHref}
          />
        )}

        {org && org.organization.status !== "ACTIVE" && (
          <OrgStatusBanner status={org.organization.status} />
        )}

        <main className="flex-1 overflow-y-auto pb-16 md:pb-0">
          <div className="p-6">
            <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
          </div>
        </main>

        {/* Mobile bottom tab bar — only visible below md breakpoint */}
        <nav className="md:hidden fixed bottom-0 left-0 right-0 z-20 bg-white border-t border-zinc-200 flex">
          {MOBILE_TABS.map(({ label, path, Icon }) => {
            const isActive = pathname.includes(
              `/dashboard/organization/${orgId}/${path}`,
            );
            return (
              <Link
                key={path}
                href={`/dashboard/organization/${orgId}/${path}`}
                className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium transition-colors ${
                  isActive
                    ? "text-zinc-900"
                    : "text-zinc-500 hover:text-zinc-700"
                }`}
              >
                <Icon
                  className={`h-5 w-5 ${isActive ? "text-zinc-900" : "text-zinc-400"}`}
                />
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
