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
  Coins,
  BarChart3,
  Settings,
  Wallet,
  UserCog,
  Building2,
  LayoutDashboard,
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
  type CollapsibleSidebarItem,
} from "@/components/dashboard/CollapsibleSidebar";
import { OrgContextBar } from "@/components/dashboard/OrgContextBar";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { signOut, useSession } from "@/lib/auth-client";
import { disconnectStreamClients } from "@/providers/StreamProvider";

interface OrgDetailsResponse {
  organization: { id: string; name: string; slug: string; logo: string | null };
  profile: {
    id: string;
    kind: "BUYER" | "PROVIDER" | "HYBRID";
    status: string;
    billingMode: "TAG_ONLY" | "SEAT_PACK" | "INVOICED_MONTHLY" | "PREPAID_UNLIMITED" | null;
  };
  membership: { role: string; status: string };
}

async function fetchOrg(orgId: string): Promise<OrgDetailsResponse> {
  const res = await fetch(`/api/organizations/${orgId}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load organization");
  }
  return res.json();
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
    queryKey: ["organization", orgId],
    queryFn: () => fetchOrg(orgId),
    enabled: !!orgId && !!session?.user?.id,
    staleTime: 60_000,
  });

  // Compute the sidebar items based on org kind, billing mode, AND role.
  // Lower roles see fewer nav items — the API layer enforces this too,
  // but hiding the pages prevents confusion.
  const sidebarItems: CollapsibleSidebarItem[] = useMemo(() => {
    if (!org) return [];
    const isProviderOrHybrid =
      org.profile.kind === "PROVIDER" || org.profile.kind === "HYBRID";
    const isBuyerOrHybrid =
      org.profile.kind === "BUYER" || org.profile.kind === "HYBRID";

    // Role rank check — mirrors ORG_ROLE_RANK from lib/auth-helpers.ts
    const role = org.membership.role;
    const RANKS: Record<string, number> = {
      ORG_OWNER: 100, ORG_ADMIN: 80, ORG_MANAGER: 60,
      ORG_CONSULTANT: 40, ORG_SUPPORT: 30, ORG_LEARNER: 20,
    };
    const isAtLeast = (min: string) =>
      (RANKS[role] ?? 0) >= (RANKS[min] ?? 0);

    const items: { name: string; icon: LucideIcon; path: string; show?: boolean }[] = [
      { name: "Overview", icon: Home, path: "home" },
      { name: "Members", icon: Users, path: "members" },
      { name: "Invitations", icon: Mail, path: "invitations", show: isAtLeast("ORG_ADMIN") },
      { name: "Learners", icon: GraduationCap, path: "learners", show: isBuyerOrHybrid },
      { name: "Consultants", icon: UserCog, path: "consultants", show: isProviderOrHybrid },
      { name: "Plans", icon: Briefcase, path: "plans" },
      {
        name: "Credits",
        icon: Coins,
        path: "credits",
        show: org.profile.billingMode === "SEAT_PACK" && isAtLeast("ORG_MANAGER"),
      },
      {
        name: "Billing",
        icon: CreditCard,
        path: "billing",
        // BUYER/HYBRID only — PROVIDER orgs don't have a billing mode
        show: isBuyerOrHybrid && isAtLeast("ORG_MANAGER"),
      },
      {
        name: "Payouts",
        icon: Wallet,
        path: "payouts",
        show: isProviderOrHybrid,
      },
      { name: "Analytics", icon: BarChart3, path: "analytics", show: isAtLeast("ORG_MANAGER") },
      { name: "Settings", icon: Settings, path: "settings", show: isAtLeast("ORG_ADMIN") },
    ];

    return items
      .filter((it) => it.show !== false)
      .map(({ show: _show, ...rest }) => rest);
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

  const personalHref = userExt?.consultantProfileId
    ? `/dashboard/consultant/${userExt.consultantProfileId}/home`
    : userExt?.consulteeProfileId
      ? `/dashboard/consultee/${userExt.consulteeProfileId}/home`
      : "/dashboard";

  // Other orgs the user belongs to (excluding the current one)
  const otherOrgs = (userExt?.organizationMemberships ?? []).filter(
    (m) => m.organizationId !== orgId,
  );

  // Single top dropdown — context switching, account actions, sign out.
  // Consolidating into one dropdown avoids the "which dropdown has what"
  // confusion of the two-dropdown pattern. Bottom strip is pure identity
  // display (no click target).
  const settingsHref = `/dashboard/organization/${orgId}/settings`;

  const topDropdownActions: NonNullable<
    React.ComponentProps<typeof CollapsibleSidebar>["topDropdownActions"]
  > = [
    {
      type: "item",
      label: "Personal Dashboard",
      href: personalHref,
      icon: LayoutDashboard,
    },
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

  // Subtitle under the org name: the user's role in THIS org.
  // Kind + billing mode live in the top-bar badges (non-redundant split —
  // sidebar subtitle is user-specific, top-bar badges are org-specific).
  const ROLE_LABELS: Record<string, string> = {
    ORG_OWNER: "Owner",
    ORG_ADMIN: "Admin",
    ORG_MANAGER: "Manager",
    ORG_CONSULTANT: "Consultant",
    ORG_SUPPORT: "Support",
    ORG_LEARNER: "Learner",
  };
  const topSubtitle = org
    ? (ROLE_LABELS[org.membership.role] ?? org.membership.role)
    : null;

  // Map URL segments to human-readable page names so the breadcrumbs match
  // the heading the user actually sees on the page.
  const PAGE_LABELS: Record<string, string> = {
    home:        "Overview",
    members:     "Members",
    invitations: "Invitations",
    learners:    "Learners",
    consultants: "Consultants",
    plans:       "Plans",
    credits:     "Credits",
    billing:     "Billing",
    payouts:     "Payouts",
    analytics:   "Analytics",
    settings:    "Settings",
    sso:         "SSO",
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
          items={sidebarItems}
          basePath={`/dashboard/organization/${orgId}`}
          title={org?.organization.name ?? "Organization"}
          avatarFallback={(org?.organization.name ?? "O")
            .charAt(0)
            .toUpperCase()}
          userName={org?.organization.name}
          userImage={org?.organization.logo}
          userSubtitle={topSubtitle}
          topDropdownActions={topDropdownActions}
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
            kind={org.profile.kind}
            billingMode={org.profile.billingMode}
            breadcrumbs={breadcrumbs}
          />
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
