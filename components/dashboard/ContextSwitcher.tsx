"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MemberRole, MemberStatus, OrgStatus } from "@prisma/client";
import {
  Briefcase,
  Building2,
  Check,
  ChevronsUpDown,
  GraduationCap,
  LayoutGrid,
  LifeBuoy,
  Plus,
  Shield,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/utils/tailwind";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSidebarCollapsed } from "@/components/dashboard/CollapsibleSidebar";
import { useSession } from "@/lib/auth-client";
import { canAddConsultantIdentity } from "@/utils/onboarding-shared";
import {
  resolveDashboardFacets,
  type DashboardFacet,
  type DashboardFacetKind,
  type DashboardFacetMembership,
} from "@/lib/labels/personal-dashboard";

interface AllMembershipsRow {
  organizationId: string;
  orgName: string;
  orgLogo: string | null;
  orgStatus: OrgStatus;
  role: MemberRole;
  status: MemberStatus;
}

// The session carries ACTIVE memberships of ACTIVE orgs only; the rest are
// fetched when the menu opens (#1527 — widening the session costs every request).
async function fetchAllMemberships(): Promise<DashboardFacetMembership[]> {
  const res = await fetch("/api/user/org-memberships?all=1");
  if (!res.ok) throw new Error("Failed to load organizations");
  const body = (await res.json()) as { data?: AllMembershipsRow[] };
  return (body.data ?? []).map((m) => ({
    organizationId: m.organizationId,
    organizationName: m.orgName,
    organizationLogo: m.orgLogo,
    role: m.role,
    status: m.status,
    orgStatus: m.orgStatus,
  }));
}

/** Which facet the current route belongs to. */
function activeFacetKey(pathname: string): string | null {
  const org = /^\/dashboard\/organization\/([^/]+)/.exec(pathname)?.[1];
  if (org && org !== "create") return `org:${org}`;
  const prefixes: Array<[string, DashboardFacetKind]> = [
    ["/dashboard/consultant/", "expert"],
    ["/dashboard/consultee/", "client"],
    ["/dashboard/org-workspace/", "workspace"],
    ["/dashboard/admin", "admin"],
    ["/dashboard/staff/", "staff"],
  ];
  return prefixes.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? null;
}

const FACET_ICON: Record<DashboardFacetKind, LucideIcon> = {
  expert: Briefcase,
  client: GraduationCap,
  workspace: LayoutGrid,
  organization: Building2,
  admin: Shield,
  staff: LifeBuoy,
};

function FacetGlyph({ facet }: Readonly<{ facet: DashboardFacet }>) {
  const Icon = FACET_ICON[facet.kind];
  return (
    <Avatar className="h-8 w-8 shrink-0 rounded-md">
      {facet.image && <AvatarImage src={facet.image} alt="" />}
      <AvatarFallback className="rounded-md bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
        <Icon className="h-4 w-4" />
      </AvatarFallback>
    </Avatar>
  );
}

function FacetItem({
  facet,
  active,
}: Readonly<{ facet: DashboardFacet; active: boolean }>) {
  return (
    <DropdownMenuItem asChild>
      <Link
        href={facet.href}
        aria-current={active ? "page" : undefined}
        className="flex cursor-pointer items-center gap-3"
      >
        <FacetGlyph facet={facet} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {facet.label}
          </p>
          {(facet.roleLabel || facet.statusLabel) && (
            <div className="mt-0.5 flex items-center gap-1">
              {facet.roleLabel && (
                <span className="text-[11px] text-zinc-500">
                  {facet.roleLabel}
                </span>
              )}
              {facet.statusLabel && (
                <Badge variant="outline" className="h-4 px-1 text-[10px]">
                  {facet.statusLabel}
                </Badge>
              )}
            </div>
          )}
        </div>
        {active && (
          <Check className="h-4 w-4 shrink-0 text-zinc-900 dark:text-zinc-100" />
        )}
      </Link>
    </DropdownMenuItem>
  );
}

function FacetSection({
  title,
  facets,
  activeKey,
}: Readonly<{
  title: string;
  facets: DashboardFacet[];
  activeKey: string | null;
}>) {
  if (facets.length === 0) return null;
  return (
    <>
      <DropdownMenuLabel className="text-xs font-normal text-zinc-500">
        {title}
      </DropdownMenuLabel>
      {facets.map((facet) => (
        <FacetItem
          key={facet.key}
          facet={facet}
          active={facet.key === activeKey}
        />
      ))}
    </>
  );
}

export interface ContextSwitcherProps {
  /**
   * Trigger identity override — e.g. the org shell passes the loaded org,
   * which may be absent from the session (PENDING_VERIFICATION).
   */
  current?: { name: string; image?: string | null; label: string };
}

/**
 * Top-left facet switcher for every dashboard shell (#1527 Q1): You (Expert,
 * Client), Organizations (All organizations + each membership with a status
 * badge), Platform (Admin, Staff), plus Create organization / Become an
 * expert when entitled. Always rendered — it hosts those two actions even for
 * a single-facet user.
 */
export function ContextSwitcher({ current }: Readonly<ContextSwitcherProps>) {
  const { data: session } = useSession();
  const pathname = usePathname() ?? "";
  const collapsed = useSidebarCollapsed();
  const [open, setOpen] = useState(false);
  const user = session?.user;

  const { data: allMemberships } = useQuery({
    queryKey: ["user-org-memberships", "all"],
    queryFn: fetchAllMemberships,
    enabled: open && !!user?.id,
    staleTime: 60_000,
  });

  const facets = useMemo(() => {
    const sessionMemberships: DashboardFacetMembership[] = (
      user?.organizationMemberships ?? []
    ).map((m) => ({
      organizationId: m.organizationId,
      organizationName: m.organizationName,
      organizationLogo: m.organizationLogo,
      role: m.role,
    }));
    return resolveDashboardFacets({
      role: user?.role,
      canBecomeExpert: user
        ? canAddConsultantIdentity({
            role: user.role,
            onboardingCompleted: user.onboardingCompleted,
            consultantProfileId: user.consultantProfileId,
          })
        : false,
      consultantProfileId: user?.consultantProfileId,
      consulteeProfileId: user?.consulteeProfileId,
      orgWorkspaceProfileId: user?.orgWorkspaceProfileId,
      staffProfileId: user?.staffProfileId,
      memberships: allMemberships ?? sessionMemberships,
    });
  }, [user, allMemberships]);

  const activeKey = activeFacetKey(pathname);
  const activeFacet = [
    ...facets.you,
    ...facets.organizations,
    ...facets.platform,
  ].find((f) => f.key === activeKey);

  const userName = user?.name ?? "";
  let trigger = { name: userName, image: user?.image ?? null, label: "" };
  if (current) {
    trigger = {
      name: current.name,
      image: current.image ?? null,
      label: current.label,
    };
  } else if (activeFacet?.kind === "organization") {
    trigger = {
      name: activeFacet.label,
      image: activeFacet.image ?? null,
      label: activeFacet.roleLabel ?? "",
    };
  } else if (activeFacet) {
    trigger = {
      name: userName,
      image: user?.image ?? null,
      label: activeFacet.label,
    };
  }
  const { createOrganizationHref, becomeExpertHref } = facets.actions;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Switch dashboard"
          className={cn(
            "flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            collapsed && "justify-center px-0",
          )}
        >
          <Avatar className="h-8 w-8 shrink-0 rounded-md">
            {trigger.image && <AvatarImage src={trigger.image} alt="" />}
            <AvatarFallback className="rounded-md bg-zinc-900 text-xs font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900">
              {(trigger.name || "F").charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          {!collapsed && (
            <>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium leading-tight text-zinc-900 dark:text-zinc-100">
                  {trigger.name}
                </p>
                {trigger.label && (
                  <p className="mt-0.5 truncate text-xs leading-tight text-zinc-500 dark:text-zinc-400">
                    {trigger.label}
                  </p>
                )}
              </div>
              <ChevronsUpDown className="h-4 w-4 shrink-0 text-zinc-400" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="start" className="w-72">
        <FacetSection title="You" facets={facets.you} activeKey={activeKey} />
        {facets.you.length > 0 && facets.organizations.length > 0 && (
          <DropdownMenuSeparator />
        )}
        <FacetSection
          title="Organizations"
          facets={facets.organizations}
          activeKey={activeKey}
        />
        {facets.platform.length > 0 && <DropdownMenuSeparator />}
        <FacetSection
          title="Platform"
          facets={facets.platform}
          activeKey={activeKey}
        />
        {(createOrganizationHref || becomeExpertHref) && (
          <DropdownMenuSeparator />
        )}
        {createOrganizationHref && (
          <DropdownMenuItem asChild>
            <Link
              href={createOrganizationHref}
              className="flex cursor-pointer items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300"
            >
              <Plus className="h-4 w-4" />
              Create organization
            </Link>
          </DropdownMenuItem>
        )}
        {becomeExpertHref && (
          <DropdownMenuItem asChild>
            <Link
              href={becomeExpertHref}
              className="flex cursor-pointer items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300"
            >
              <Sparkles className="h-4 w-4" />
              Become an expert
            </Link>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
