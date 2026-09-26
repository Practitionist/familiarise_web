"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import React, { use, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Clock } from "lucide-react";

import { usePrefetchNavPaths } from "@/hooks/usePrefetchNavPaths";
import {
  DashboardShell,
  DashboardShellSkeleton,
} from "@/components/dashboard/DashboardShell";
import { ContextSwitcher } from "@/components/dashboard/ContextSwitcher";
import { BreadcrumbOverrideProvider } from "@/components/dashboard/breadcrumb-override";
import { useDashboardBreadcrumbs } from "@/components/dashboard/breadcrumbs";
import { useSession } from "@/lib/auth-client";
import { signOutEverywhere } from "@/lib/auth/sign-out";
import { hasOrgPermission, type OrgSurface } from "@/lib/auth/org-permissions";
import {
  MEMBER_ROLE_LABEL,
  deriveCapabilityKind,
  CAPABILITY_LABEL,
  CAPABILITY_BADGE_CLASS,
  FUNDING_SOURCE_LABEL,
  FUNDING_SOURCE_BADGE_CLASS,
} from "@/lib/labels/org-labels";
import {
  buildOrganizationNav,
  ORGANIZATION_PAGE_LABELS,
} from "@/lib/dashboard/nav/organization";
import type { OrgStatus } from "@prisma/client";
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
  const copy: Record<
    OrgStatus,
    { title: string; body: string; tone: string } | null
  > = {
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
    <div className="flex items-center justify-center min-h-svh bg-zinc-100">
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

export default function OrgDashboardShell(
  props: Readonly<{
    children: React.ReactNode;
    params: Promise<{ orgId: string }>;
  }>,
) {
  // Record-id crumbs read their human label from pages under this tree.
  return (
    <BreadcrumbOverrideProvider>
      <OrgDashboardShellInner {...props} />
    </BreadcrumbOverrideProvider>
  );
}

function OrgDashboardShellInner({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}>) {
  const { orgId } = use(params);
  const pathname = usePathname() ?? "";
  const { data: session, isPending: isSessionLoading } = useSession();

  const { data: org, error } = useQuery({
    queryKey: orgDetailsQueryKey(orgId),
    queryFn: () => fetchOrgDetails(orgId),
    enabled: !!orgId && !!session?.user?.id,
    staleTime: 60_000,
  });

  // Idle-warm the highest-traffic tabs, with the same permission gates as
  // the nav — a hidden surface is not prefetched (it would render "forbidden").
  const prefetchPaths = useMemo(() => {
    if (!org?.organization || org.organization.status !== "ACTIVE") return [];
    const base = `/dashboard/organization/${orgId}`;
    const can = (surface: OrgSurface) =>
      hasOrgPermission(org.membership.role, surface);
    const paths = [`${base}/home`, `${base}/appointments`];
    if (can("members.read")) paths.push(`${base}/members`);
    if (can("operations.read")) paths.push(`${base}/analytics`);
    if (can("billing.read") && org.organization.canSponsor)
      paths.push(`${base}/billing`);
    return paths;
  }, [org, orgId]);
  usePrefetchNavPaths(prefetchPaths);

  // Permission-filtered IA lives in a pure builder so tests can walk every
  // role × capability × funding combination (#1527).
  const nav = useMemo(
    () =>
      buildOrganizationNav({
        orgId,
        role: org?.membership.role ?? "LEARNER",
        canSponsor: org?.organization.canSponsor ?? false,
        canHost: org?.organization.canHost ?? false,
        fundingSource: org?.organization.fundingSource ?? null,
        requiresPO: org?.organization.requiresPO ?? false,
        consultantProfileId: org?.membership.consultantProfileId ?? null,
      }),
    [org, orgId],
  );

  const breadcrumbs = useDashboardBreadcrumbs({
    pathname,
    basePath: nav.basePath,
    pageLabels: ORGANIZATION_PAGE_LABELS,
  });

  if (!session?.user?.id && !isSessionLoading) {
    return (
      <AccessDenied
        title="Authentication Required"
        message="Please sign in to access the organization dashboard."
      />
    );
  }

  if (error && !org) {
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

  if (!org) {
    return <DashboardShellSkeleton />;
  }

  const roleLabel = MEMBER_ROLE_LABEL[org.membership.role];
  const capability = deriveCapabilityKind(
    org.organization.canSponsor,
    org.organization.canHost,
  );
  const fundingSource = org.organization.fundingSource;

  return (
    <DashboardShell
      kind="organization"
      nav={nav}
      switcher={
        <ContextSwitcher
          current={{
            name: org.organization.name,
            image: org.organization.logo,
            label: roleLabel,
          }}
        />
      }
      account={{
        name: session?.user?.name ?? null,
        image: session?.user?.image ?? null,
        roleLabel,
      }}
      onSignOut={() => void signOutEverywhere()}
      contextBar={{
        identity: {
          name: org.organization.name,
          image: org.organization.logo,
        },
        badges: [
          {
            label: CAPABILITY_LABEL[capability],
            className: CAPABILITY_BADGE_CLASS[capability],
          },
          ...(fundingSource
            ? [
                {
                  label: FUNDING_SOURCE_LABEL[fundingSource],
                  className: FUNDING_SOURCE_BADGE_CLASS[fundingSource],
                },
              ]
            : []),
        ],
        breadcrumbs,
      }}
      banner={
        org.organization.status === "ACTIVE" ? undefined : (
          <OrgStatusBanner status={org.organization.status} />
        )
      }
      pathname={pathname}
    >
      {children}
    </DashboardShell>
  );
}
