"use client";

/**
 * Shared inner layout for the consultant + consultee dashboards (Batch C3).
 * The two layouts were ~85% identical (session/userId plumbing, Stream
 * provider, capability gate + guarded redirect, prefetch, breadcrumbs,
 * auth/access/skeleton/error early returns) with a repeated joint-fix history
 * — every fix had to land twice. There is now one implementation:
 * kind-specific data (nav, labels, fetchers, guards, error UX, verification
 * extras, user wrapping) is injected as props. Chrome, Novu and the error
 * boundary live in DashboardShell (#1527).
 */

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  LifeBuoy,
  Lock,
  Settings,
  UserRound,
  type LucideIcon,
} from "lucide-react";

import {
  DashboardShell,
  DashboardShellSkeleton,
} from "@/components/dashboard/DashboardShell";
import { ContextSwitcher } from "@/components/dashboard/ContextSwitcher";
import {
  useDashboardBreadcrumbs,
  type OfferingsCrumbConfig,
} from "@/components/dashboard/breadcrumbs";
import type { DashboardContextBarBadge } from "@/components/dashboard/DashboardContextBar";
import StreamProvider from "@/providers/StreamProvider";
import { useSession } from "@/lib/auth-client";
import { signOutEverywhere } from "@/lib/auth/sign-out";
import { getEffectiveUserId } from "@/utils/auth";
import { useServerUserId } from "@/components/dashboard/ServerUserId";
import { schedulePrefetch } from "@/lib/dashboard-queries";
import type { DashboardNav } from "@/lib/dashboard/nav/types";

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
  /** Pure nav from `lib/dashboard/nav/{consultant,consultee}.ts`. */
  nav: DashboardNav;
  /** Counts keyed by `NavItem.badgeKey`. */
  badges?: Record<string, number | undefined>;
  /** Account chip role ("Expert" / "Client") + identity fallback name. */
  chipRole: string;
  identityFallbackName: string;
  pageLabels: Record<string, string>;
  pathlessSegments?: ReadonlySet<string>;
  offeringsConfig?: OfferingsCrumbConfig;
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
  useExtras?: (ctx: PersonalDashboardExtrasCtx<P>) => PersonalDashboardExtras;
  wrapShell?: (
    shell: React.ReactNode,
    user: PersonalDashboardUser,
  ) => React.ReactNode;
  children: React.ReactNode;
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
  nav,
  badges,
  chipRole,
  identityFallbackName,
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
  const { basePath } = nav;

  // Fall back to the server-resolved id: useSession() is still pending during
  // SSR, so without this the query key below is ["user-details", undefined]
  // and the server seed in app/dashboard/layout.tsx can never be read (#1105).
  const serverUserId = useServerUserId();
  const userId = getEffectiveUserId(session) ?? serverUserId;

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
    enabled: profileGatesOnUser ? !!userId && !isSessionLoading : !!routeParam,
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

  const breadcrumbs = useDashboardBreadcrumbs({
    pathname,
    basePath,
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
          {children}
        </StreamProvider>
      ) : (
        children
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
    return <DashboardShellSkeleton />;
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
    return (
      <DefaultError message={error.message || "Failed to load dashboard"} />
    );
  }

  if (requireUserDetails && !userDetails) {
    return <DashboardShellSkeleton />;
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

  // Account only (#1527 Q1): context switching lives in the switcher.
  const shell = (
    <DashboardShell
      kind="personal"
      nav={nav}
      badges={badges}
      switcher={<ContextSwitcher />}
      account={{
        name: userName,
        image: userImage,
        roleLabel: chipRole,
        actions: [
          { label: "Settings", href: `${basePath}/settings`, icon: Settings },
          {
            label: "Help & support",
            href: `${basePath}/support`,
            icon: LifeBuoy,
          },
        ],
      }}
      onSignOut={() => void signOutEverywhere()}
      contextBar={{
        identity: {
          name: userName ?? identityFallbackName,
          image: userImage,
          FallbackIcon: UserRound,
        },
        badges: extras.badges ?? [],
        breadcrumbs,
      }}
      banner={extras.banner}
      pathname={pathname}
    >
      {memoizedStreamContent}
    </DashboardShell>
  );

  return (
    <>
      {extras.overlay}
      {userDetails ? wrapShell(shell, userDetails) : shell}
    </>
  );
}
