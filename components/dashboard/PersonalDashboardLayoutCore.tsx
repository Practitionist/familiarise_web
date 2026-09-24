"use client";

/**
 * Shared inner layout for the consultant + consultee dashboards (Batch C3).
 * The two layouts were ~85% identical (session/userId plumbing, Novu/Stream
 * providers, capability gate + guarded redirect, prefetch, org chip,
 * id-dropping breadcrumbs, auth/access/skeleton/error early returns) with a
 * repeated joint-fix history — every fix had to land twice. There is now one
 * implementation: kind-specific data (nav, labels, fetchers, guards, error
 * UX, verification extras, user wrapping) is injected as props.
 */

import { useParams, usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Building2, Lock, UserRound, type LucideIcon } from "lucide-react";

import {
  PersonalDashboardShell,
  PersonalDashboardShellSkeleton,
  type PersonalDashboardMobileTab,
} from "@/components/dashboard/PersonalDashboardShell";
import type { CollapsibleSidebarGroup } from "@/components/dashboard/CollapsibleSidebar";
import { useBreadcrumbOverride } from "@/components/dashboard/breadcrumb-override";
import type { DashboardContextBarBadge } from "@/components/dashboard/DashboardContextBar";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import StreamProvider from "@/providers/StreamProvider";
import NovuProvider from "@/providers/NovuProvider";
import { useNovuSubscriberSync } from "@/hooks/useNovuSubscriberSync";
import { useSession } from "@/lib/auth-client";
import { signOutEverywhere } from "@/lib/auth/sign-out";
import { getEffectiveUserId } from "@/utils/auth";
import { useServerUserId } from "@/components/dashboard/ServerUserId";
import { schedulePrefetch } from "@/lib/dashboard-queries";

/** Minimal user shape the core reads. Fetchers return richer types. */
export interface PersonalDashboardUser {
  id?: string | null;
  role?: string | null;
  name?: string | null;
  image?: string | null;
  consultantProfileId?: string | null;
  consulteeProfileId?: string | null;
}

export interface PersonalDashboardExtras {
  overlay?: React.ReactNode;
  banner?: React.ReactNode;
  badges?: DashboardContextBarBadge[];
}

export interface PersonalDashboardExtrasCtx<P> {
  profile: P | null | undefined;
  userDetails: PersonalDashboardUser | null | undefined;
  userId: string | null | undefined;
  routeParam: string;
  basePath: string;
  pathname: string;
}

export interface PersonalDashboardCoreProps<P> {
  routeParam: string;
  basePath: string;
  title: string;
  /** Sidebar chip role ("Consultant" / "Client") + identity fallback name. */
  chipRole: string;
  identityFallbackName: string;
  navGroups: CollapsibleSidebarGroup[];
  mobileTabs: PersonalDashboardMobileTab[];
  pageLabels: Record<string, string>;
  pathlessSegments?: ReadonlySet<string>;
  offeringsConfig?: {
    typeSegments: ReadonlySet<string>;
    listingHref: string;
  };
  fetchUser: (userId: string) => Promise<PersonalDashboardUser | null>;
  profileQueryKey: readonly unknown[];
  fetchProfile: () => Promise<P | null>;
  /** False for the consultee tree, whose profile gates on the route param. */
  profileGatesOnUser?: boolean;
  profileStreamUserId?: (
    profile: P | null | undefined,
  ) => string | null | undefined;
  profileDisplayName?: (
    profile: P | null | undefined,
  ) => string | null | undefined;
  profileDisplayImage?: (
    profile: P | null | undefined,
  ) => string | null | undefined;
  hasAccess: (
    user: PersonalDashboardUser | null | undefined,
    routeParam: string,
  ) => boolean;
  resolveRedirectTarget: (user: PersonalDashboardUser) => string;
  prefetchSuffixes: string[];
  /** Consultee tree returns to skeleton when userDetails is absent. */
  requireUserDetails?: boolean;
  /** Consultee tree counts a user-query failure as a layout error. */
  includeUserError?: boolean;
  renderError?: (message: string) => React.ReactNode;
  useExtras?: (
    ctx: PersonalDashboardExtrasCtx<P>,
  ) => PersonalDashboardExtras;
  wrapShell?: (
    shell: React.ReactNode,
    user: PersonalDashboardUser,
  ) => React.ReactNode;
  children: React.ReactNode;
}

// Opaque record ids (cuid / uuid) in nested routes carry no meaning as crumbs.
const looksLikeRecordId = (segment: string) =>
  /^[a-z0-9]{20,}$/i.test(segment) ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    segment,
  );

interface Crumb {
  label: string;
  href?: string;
}

/** Text out of an untyped membership payload: strings/numbers pass through,
 *  everything else is empty (never "[object Object]"). */
function toText(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

interface SegmentCrumbCtx {
  seg: string;
  acc: string;
  overrideLabel: string | null;
  onOfferings: boolean;
  offeringsConfig:
    | { typeSegments: ReadonlySet<string>; listingHref: string }
    | undefined;
  offeringsListingHref: string;
  pageLabels: Record<string, string>;
  pathlessSegments: ReadonlySet<string> | undefined;
  paramValues: ReadonlySet<string>;
}

function resolveSegmentCrumb(ctx: Readonly<SegmentCrumbCtx>): Crumb | null {
  const {
    seg,
    acc,
    overrideLabel,
    onOfferings,
    offeringsConfig,
    offeringsListingHref,
    pageLabels,
    pathlessSegments,
    paramValues,
  } = ctx;
  if (looksLikeRecordId(seg)) {
    // The label goes HERE, in the id's own position — that segment IS the
    // record, so its human name belongs where the id was.
    if (overrideLabel) return { label: overrideLabel, href: acc };
    return null;
  }
  if (
    offeringsConfig &&
    (seg === "offerings" ||
      (onOfferings && offeringsConfig.typeSegments.has(seg)))
  ) {
    // Offerings have no list route of their own — the Event Planner is where
    // those rows live. Point both the "Offerings" crumb and the type crumb
    // there so the trail is clickable without prefetching a 404.
    return {
      label: pageLabels[seg] ?? seg,
      href: offeringsListingHref,
    };
  }
  const navigable = pathlessSegments
    ? !pathlessSegments.has(seg) && !paramValues.has(seg)
    : true;
  return {
    label: pageLabels[seg] ?? seg,
    ...(navigable ? { href: acc } : {}),
  };
}

function delinkTerminalCrumb(
  crumbs: readonly Crumb[],
  pathname: string,
): Crumb[] {
  return crumbs.map((crumb, index) => {
    const isLast = index === crumbs.length - 1;
    // Keep a link when the visible crumb is still a parent of the URL
    // (happens when the last segment was an opaque id we stripped).
    if (isLast && crumb.href && pathname === crumb.href) {
      return { label: crumb.label };
    }
    return crumb;
  });
}

interface BreadcrumbsInput {
  pathname: string;
  basePath: string;
  overrideLabel: string | null;
  pageLabels: Record<string, string>;
  pathlessSegments: ReadonlySet<string> | undefined;
  offeringsConfig:
    | { typeSegments: ReadonlySet<string>; listingHref: string }
    | undefined;
}

// Full breadcrumb trail — every URL segment after the route id becomes a
// crumb; opaque record ids are dropped (or replaced with an override label
// such as the appointment title). Parent crumbs keep an href so users can
// click back, but only when the accumulated path is a route the app can
// actually serve.
function useDashboardBreadcrumbs(
  input: Readonly<BreadcrumbsInput>,
): Crumb[] {
  const {
    pathname,
    basePath,
    overrideLabel,
    pageLabels,
    pathlessSegments,
    offeringsConfig,
  } = input;
  const routeParams = useParams();
  return useMemo(() => {
    // Every value the current route bound to a dynamic param. Such a segment
    // is never a URL of its own, so its crumb must not be a link.
    const paramValues = new Set<string>();
    for (const value of Object.values(routeParams ?? {})) {
      for (const part of Array.isArray(value) ? value : [value]) {
        if (part) paramValues.add(part);
      }
    }
    const parts = pathname.replace(basePath, "").split("/").filter(Boolean);
    const onOfferings = !!offeringsConfig && parts[0] === "offerings";
    const offeringsListingHref = offeringsConfig
      ? `${basePath}/${offeringsConfig.listingHref}`
      : basePath;

    const crumbs: Crumb[] = [];
    let acc = basePath;
    for (const seg of parts) {
      acc = `${acc}/${seg}`;
      const crumb = resolveSegmentCrumb({
        seg,
        acc,
        overrideLabel,
        onOfferings,
        offeringsConfig,
        offeringsListingHref,
        pageLabels,
        pathlessSegments,
        paramValues,
      });
      if (crumb) crumbs.push(crumb);
    }
    return delinkTerminalCrumb(crumbs, pathname);
  }, [
    pathname,
    basePath,
    overrideLabel,
    pageLabels,
    pathlessSegments,
    offeringsConfig,
    routeParams,
  ]);
}

function AccessCard({
  Icon,
  title,
  tone = "amber",
  children,
}: Readonly<{
  Icon: LucideIcon;
  title: string;
  tone?: "amber" | "red";
  children: React.ReactNode;
}>) {
  return (
    <div className="flex items-center justify-center min-h-svh bg-zinc-100">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white p-8 rounded-2xl shadow-xl border border-zinc-200 max-w-md text-center"
      >
        <div
          className={`w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center ${
            tone === "red" ? "bg-red-100" : "bg-amber-100"
          }`}
        >
          <Icon
            className={`w-8 h-8 ${tone === "red" ? "text-red-600" : "text-amber-600"}`}
          />
        </div>
        <h2 className="text-xl font-bold text-zinc-900 mb-2">{title}</h2>
        {children}
      </motion.div>
    </div>
  );
}

function DefaultError({ message }: Readonly<{ message: string }>) {
  return (
    <AccessCard Icon={Lock} title="Something went wrong" tone="red">
      <p className="text-zinc-600">{message || "Failed to load dashboard"}</p>
      <button
        onClick={() => window.location.reload()}
        className="mt-6 px-6 py-2.5 bg-zinc-900 text-white rounded-lg font-medium hover:bg-zinc-800 transition-colors"
      >
        Try Again
      </button>
    </AccessCard>
  );
}

const noExtras = () => ({});
const identityWrap = (shell: React.ReactNode) => shell;

export function PersonalDashboardLayoutCore<P>({
  routeParam,
  basePath,
  title,
  chipRole,
  identityFallbackName,
  navGroups,
  mobileTabs,
  pageLabels,
  pathlessSegments,
  offeringsConfig,
  fetchUser,
  profileQueryKey,
  fetchProfile,
  profileGatesOnUser = true,
  profileStreamUserId,
  profileDisplayName,
  profileDisplayImage,
  hasAccess,
  resolveRedirectTarget,
  prefetchSuffixes,
  requireUserDetails = false,
  includeUserError = false,
  renderError,
  useExtras = noExtras,
  wrapShell = identityWrap,
  children,
}: Readonly<PersonalDashboardCoreProps<P>>) {
  const pathname = usePathname();
  const { data: session, isPending: isSessionLoading } = useSession();
  const router = useRouter();

  // Fall back to the server-resolved id: useSession() is still pending during
  // SSR, so without this the query key below is ["user-details", undefined]
  // and the server seed in app/dashboard/layout.tsx can never be read (#1105).
  const serverUserId = useServerUserId();
  const userId = getEffectiveUserId(session) ?? serverUserId;

  // Sync user as Novu subscriber (once per session)
  useNovuSubscriberSync();

  const {
    data: userDetails,
    error: userQueryError,
    isLoading: isLoadingUserDetails,
  } = useQuery({
    queryKey: ["user-details", userId],
    queryFn: () => fetchUser(userId!),
    enabled: !!userId && !isSessionLoading,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
  });

  const {
    data: profileData,
    error: profileError,
    isLoading: isLoadingProfile,
  } = useQuery({
    queryKey: [...profileQueryKey],
    queryFn: fetchProfile,
    enabled: profileGatesOnUser
      ? !!userId && !isSessionLoading
      : !!routeParam,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
    placeholderData: (previousData) => previousData,
  });

  const extras = useExtras({
    profile: profileData,
    userDetails,
    userId,
    routeParam,
    basePath,
    pathname,
  });

  const hasCoreAccess = hasAccess(userDetails, routeParam);

  // Redirect unauthorized users to their appropriate dashboard. Guarded:
  // without it a stale `user-details` payload (≤5-min React-Query cache, or a
  // profile just added server-side) could bounce /dashboard → back here →
  // /dashboard while the server router resolves the other way, flashing
  // "Redirecting to your dashboard..." in a loop. Keyed by pathname+target:
  // this layout stays mounted across nested routes, so a *different*
  // unauthorized pathname must re-arm the navigation instead of being skipped
  // as a duplicate of an earlier one.
  const navigatedRef = useRef<{ pathname: string; target: string } | null>(
    null,
  );
  // Latest resolver without re-arming the effect: the closures are rebuilt
  // every render, but only the pathname/target pair gates navigation.
  const resolveTargetRef = useRef(resolveRedirectTarget);
  resolveTargetRef.current = resolveRedirectTarget;
  useEffect(() => {
    if (isLoadingUserDetails || isSessionLoading || !userId) return;

    if (userDetails && !hasCoreAccess) {
      const target = resolveTargetRef.current(userDetails);
      // Never replace to the URL we are already on, and never queue the same
      // pathname→target pair twice (Strict-Mode double effects / duplicate
      // query emissions).
      if (target === pathname) return;
      if (
        navigatedRef.current?.pathname === pathname &&
        navigatedRef.current?.target === target
      )
        return;
      navigatedRef.current = { pathname, target };
      router.replace(target);
    }
  }, [
    userDetails,
    hasCoreAccess,
    isLoadingUserDetails,
    isSessionLoading,
    userId,
    router,
    pathname,
  ]);

  // Prefetch critical routes on mount — once per access-resolution, NOT per
  // navigation. Route-shell prefetch only: for dynamic pages Next.js warms the
  // shell through loading.tsx, so the first click shows the skeleton instantly.
  useEffect(() => {
    if (!userId || !routeParam || !hasCoreAccess) return;

    return schedulePrefetch(() => {
      for (const suffix of prefetchSuffixes) {
        router.prefetch(`${basePath}/${suffix}`);
      }
    }, 3000);
  }, [userId, routeParam, router, hasCoreAccess, basePath, prefetchSuffixes]);

  // Org memberships for the bottom chip's "Switch to organization" section
  const orgMemberships = useMemo(() => {
    const raw = (session?.user as Record<string, unknown> | undefined)
      ?.organizationMemberships;
    if (!Array.isArray(raw)) return [];
    return raw.map((m: Record<string, unknown>) => ({
      organizationId: toText(m.organizationId),
      organizationName: toText(m.organizationName),
    }));
  }, [session?.user]);

  const { overrideLabel } = useBreadcrumbOverride();

  const breadcrumbs = useDashboardBreadcrumbs({
    pathname,
    basePath,
    overrideLabel,
    pageLabels,
    pathlessSegments,
    offeringsConfig,
  });

  const streamUserId = profileStreamUserId
    ? profileStreamUserId(profileData)
    : userDetails?.id;

  // Memoize StreamProvider children to prevent re-initialization on tab
  // switches. Must be called before any early returns (Rules of Hooks).
  const memoizedStreamContent = useMemo(
    () =>
      streamUserId ? (
        <StreamProvider
          userId={streamUserId}
          enableChat={true}
          enableVideo={true}
        >
          <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
        </StreamProvider>
      ) : (
        <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
      ),
    [streamUserId, children],
  );

  // Authentication check
  if (
    process.env.NODE_ENV !== "development" &&
    process.env.NODE_ENV !== "test" &&
    !session?.user?.id &&
    !isSessionLoading
  ) {
    return (
      <AccessCard Icon={Lock} title="Authentication Required">
        <p className="text-zinc-600">
          Please sign in to access your dashboard.
        </p>
        <a
          href="/auth/signin"
          className="inline-block mt-6 px-6 py-2.5 bg-zinc-900 text-white rounded-lg font-medium hover:bg-zinc-800 transition-colors"
        >
          Sign In
        </a>
      </AccessCard>
    );
  }

  // Access denied — before the skeleton so unauthorized users never see it
  if (userDetails && !hasCoreAccess) {
    return (
      <AccessCard Icon={Lock} title="Access Denied">
        <p className="text-zinc-600">
          You don&apos;t have permission to access this dashboard.
        </p>
        <p className="text-sm text-zinc-500 mt-2">
          Redirecting to your dashboard...
        </p>
      </AccessCard>
    );
  }

  // Initial loading — only while access is still being determined
  if (
    (isLoadingUserDetails || isLoadingProfile || isSessionLoading) &&
    !userDetails &&
    !profileData
  ) {
    return <PersonalDashboardShellSkeleton />;
  }

  // Error state (the consultee tree also counts a user-query failure;
  // the consultant tree surfaces profile errors through ErrorDisplay).
  const error = (profileError ||
    (includeUserError ? userQueryError : null)) as Error | null;
  if (error) {
    if (renderError) {
      return (
        <>
          {renderError(
            error instanceof Error ? error.message : "Failed to load dashboard",
          )}
        </>
      );
    }
    return <DefaultError message={error.message || "Failed to load dashboard"} />;
  }

  if (requireUserDetails && !userDetails) {
    return <PersonalDashboardShellSkeleton />;
  }

  const sessionName =
    typeof session?.user?.name === "string" ? session.user.name : null;
  const sessionImage =
    typeof session?.user?.image === "string" ? session.user.image : null;
  const userName =
    profileDisplayName?.(profileData) ??
    userDetails?.name ??
    sessionName ??
    null;
  const userImage =
    profileDisplayImage?.(profileData) ??
    userDetails?.image ??
    sessionImage ??
    null;

  // Bottom chip dropdown — org context switching only. Sign Out renders as
  // the standalone red button below.
  const bottomUserChipActions = [
    ...(orgMemberships.length > 0
      ? [
          { type: "separator" as const },
          { type: "label" as const, label: "Switch to organization" },
          ...orgMemberships.map((m) => ({
            type: "item" as const,
            label: m.organizationName,
            href: `/dashboard/organization/${m.organizationId}/home`,
            icon: Building2,
          })),
        ]
      : []),
  ];

  const shell = (
    <PersonalDashboardShell
      groups={navGroups}
      basePath={basePath}
      title={title}
      subtitle={userName}
      headerImage={userImage}
      bottomUserChip={{
        name: userName,
        image: userImage,
        role: chipRole,
      }}
      bottomUserChipActions={bottomUserChipActions}
      contextBar={{
        identity: {
          name: userName ?? identityFallbackName,
          image: userImage,
          FallbackIcon: UserRound,
        },
        badges: extras.badges ?? [],
        breadcrumbs,
      }}
      mobileTabs={mobileTabs}
      banner={extras.banner}
      pathname={pathname}
      onSignOut={() => void signOutEverywhere()}
    >
      {memoizedStreamContent}
    </PersonalDashboardShell>
  );

  return (
    <NovuProvider>
      {extras.overlay}
      {userDetails ? wrapShell(shell, userDetails) : shell}
    </NovuProvider>
  );
}
