"use client";

import { usePathname, useRouter } from "next/navigation";
import { use, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Home,
  CalendarCheck,
  MessageSquare,
  ListOrdered,
  FolderOpen,
  CreditCard,
  Gift,
  LifeBuoy,
  Settings,
  Building2,
  UserRound,
  Lock,
  AlertTriangle,
  type LucideIcon,
} from "lucide-react";

import {
  PersonalDashboardShell,
  PersonalDashboardShellSkeleton,
} from "@/components/dashboard/PersonalDashboardShell";
import type { CollapsibleSidebarGroup } from "@/components/dashboard/CollapsibleSidebar";
import {
  BreadcrumbOverrideProvider,
  useBreadcrumbOverride,
} from "@/components/dashboard/breadcrumb-override";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import StreamProvider from "@/providers/StreamProvider";
import NovuProvider from "@/providers/NovuProvider";
import { useNovuSubscriberSync } from "@/hooks/useNovuSubscriberSync";
import { useSession } from "@/lib/auth-client";
import { signOutEverywhere } from "@/lib/auth/sign-out";
import { getEffectiveUserId } from "@/utils/auth";
import { fetchConsulteeDetails, fetchUserDetails } from "@/lib/user";
import { schedulePrefetch } from "@/lib/dashboard-queries";
import { UserProvider } from "./UserContext";

// Grouped sidebar nav — same routes as the old top-nav, clustered for the
// shared CollapsibleSidebar (Activity / Billing / Support).
const NAV_GROUPS: CollapsibleSidebarGroup[] = [
  {
    items: [
      { name: "Home", icon: Home, path: "home" },
      { name: "Appointments", icon: CalendarCheck, path: "appointments" },
      { name: "Messages", icon: MessageSquare, path: "messages" },
    ],
  },
  {
    label: "Activity",
    items: [
      { name: "Waitlists", icon: ListOrdered, path: "waitlists" },
      { name: "Resources", icon: FolderOpen, path: "resources" },
    ],
  },
  {
    label: "Billing",
    items: [
      { name: "Payments", icon: CreditCard, path: "payments" },
      { name: "Referrals", icon: Gift, path: "referrals" },
    ],
  },
  {
    // Labelless on purpose: a group header reading "Support" above a single
    // item also called "Support" is redundant nesting — the header would
    // restate the only thing under it. Rendered as a standalone entry.
    items: [{ name: "Support", icon: LifeBuoy, path: "support" }],
  },
];

// Mobile bottom-tab configuration — 5 most-accessed consultee pages.
const MOBILE_TABS: { label: string; path: string; Icon: LucideIcon }[] = [
  { label: "Home", path: "home", Icon: Home },
  { label: "Appointments", path: "appointments", Icon: CalendarCheck },
  { label: "Messages", path: "messages", Icon: MessageSquare },
  { label: "Payments", path: "payments", Icon: CreditCard },
  { label: "Support", path: "support", Icon: LifeBuoy },
];

// Map URL segments to human-readable page names so the breadcrumbs match
// the heading the user actually sees on the page.
const PAGE_LABELS: Record<string, string> = {
  home: "Home",
  appointments: "Appointments",
  waitlists: "Waitlists",
  resources: "Resources",
  messages: "Messages",
  payments: "Payments",
  referrals: "Referrals",
  support: "Support",
  settings: "Settings",
};

// Opaque record ids (cuid / uuid) in nested routes carry no meaning as crumbs.
const looksLikeRecordId = (segment: string) =>
  /^[a-z0-9]{20,}$/i.test(segment) ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    segment,
  );

interface PageProps {
  children: React.ReactNode;
  params: Promise<{ consulteeId: string }>;
}

function AccessCard({
  Icon,
  title,
  tone = "amber",
  children,
}: {
  Icon: LucideIcon;
  title: string;
  tone?: "amber" | "red";
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-center min-h-screen bg-zinc-100">
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

export default function ConsulteeLayout(props: Readonly<PageProps>) {
  return (
    <BreadcrumbOverrideProvider>
      <ConsulteeLayoutInner {...props} />
    </BreadcrumbOverrideProvider>
  );
}

function ConsulteeLayoutInner({
  children,
  params,
}: Readonly<PageProps>) {
  const resolvedParams = use(params);
  const consulteeId = resolvedParams.consulteeId;
  const basePath = `/dashboard/consultee/${consulteeId}`;
  const pathname = usePathname();
  const { data: session, isPending: isSessionLoading } = useSession();
  const router = useRouter();

  const userId = getEffectiveUserId(session);

  // Sync user as Novu subscriber (once per session)
  useNovuSubscriberSync();

  // Fetch user details with placeholderData to prevent loading flashes
  const {
    data: userDetails,
    error: userError,
    isLoading: isLoadingUser,
  } = useQuery({
    queryKey: ["user-details", userId],
    queryFn: () => fetchUserDetails(userId!),
    enabled: !!userId && !isSessionLoading,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
    placeholderData: (previousData) => previousData,
  });

  // Consultee profile fetch — result unused directly, but it gates the
  // initial skeleton (profile 404s surface here) and warms the cache for
  // feature pages.
  const {
    error: profileError,
    isLoading: isLoadingProfile,
  } = useQuery({
    queryKey: ["consultee-profile", consulteeId],
    queryFn: () => fetchConsulteeDetails(consulteeId),
    enabled: !!consulteeId,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
    placeholderData: (previousData) => previousData,
  });

  // Capability-based (#org-appts): access is owning THIS consulteeProfile, NOT
  // "role !== CONSULTANT". A marketplace CONSULTANT sponsored by an org as a
  // learner owns a consulteeProfile and must reach their consumer surfaces —
  // the old `role !== "CONSULTANT"` lock barred them from their own dashboard.
  // ADMIN/STAFF may inspect anyone's.
  const hasConsulteeAccess =
    userDetails &&
    (userDetails.role === "ADMIN" ||
      userDetails.role === "STAFF" ||
      userDetails.consulteeProfileId === consulteeId);

  // Redirect unauthorized users to their own dashboard (capability-routed).
  useEffect(() => {
    if (isLoadingUser || isSessionLoading || !userId) return;

    if (userDetails && !hasConsulteeAccess) {
      if (
        userDetails.consulteeProfileId &&
        userDetails.consulteeProfileId !== consulteeId
      ) {
        router.replace(
          `/dashboard/consultee/${userDetails.consulteeProfileId}/home`,
        );
      } else {
        router.replace("/dashboard");
      }
    }
  }, [
    userDetails,
    hasConsulteeAccess,
    isLoadingUser,
    isSessionLoading,
    userId,
    router,
    consulteeId,
  ]);

  // Prefetch
  useEffect(() => {
    if (!userId || !consulteeId || !hasConsulteeAccess) return;

    schedulePrefetch(() => {
      if (!pathname.includes("/home")) {
        router.prefetch(`${basePath}/home`);
      }
    }, 3000);
  }, [userId, consulteeId, pathname, router, hasConsulteeAccess, basePath]);

  // Org memberships for the bottom chip's "Switch to organization" section
  const orgMemberships = useMemo(() => {
    const raw = (session?.user as Record<string, unknown> | undefined)
      ?.organizationMemberships;
    if (!Array.isArray(raw)) return [];
    return raw.map((m: Record<string, unknown>) => ({
      organizationId: String(m.organizationId ?? ""),
      organizationName: String(m.organizationName ?? ""),
    }));
  }, [session?.user]);

  const { overrideLabel } = useBreadcrumbOverride();

  // Full breadcrumb trail — opaque record ids are dropped (or replaced with
  // an override label such as the appointment title).
  const breadcrumbs = useMemo(() => {
    const parts = pathname
      .replace(basePath, "")
      .split("/")
      .filter(Boolean);

    const crumbs: { label: string; href?: string }[] = [];
    let acc = basePath;
    let lastSegWasRecordId = false;

    for (const seg of parts) {
      acc = `${acc}/${seg}`;
      if (looksLikeRecordId(seg)) {
        lastSegWasRecordId = true;
        continue;
      }
      lastSegWasRecordId = false;
      crumbs.push({
        label: PAGE_LABELS[seg] ?? seg,
        href: acc,
      });
    }

    if (lastSegWasRecordId && overrideLabel) {
      crumbs.push({ label: overrideLabel });
    }

    return crumbs.map((crumb, index) => {
      const isLast = index === crumbs.length - 1;
      if (isLast && crumb.href && pathname === crumb.href) {
        return { label: crumb.label };
      }
      return crumb;
    });
  }, [pathname, basePath, overrideLabel]);

  const isLoading = isLoadingUser || isLoadingProfile;
  const error = (userError || profileError) as Error | null;

  // Memoize StreamProvider children to prevent re-initialization on tab
  // switches. Must be called before any early returns (Rules of Hooks).
  const memoizedStreamContent = useMemo(
    () =>
      userDetails?.id ? (
        <StreamProvider
          userId={userDetails.id}
          enableChat={true}
          enableVideo={true}
        >
          <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
        </StreamProvider>
      ) : (
        <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
      ),
    [userDetails?.id, children],
  );

  // Auth check
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
  if (userDetails && !hasConsulteeAccess) {
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
  if ((isLoading || isSessionLoading) && !userDetails) {
    return <PersonalDashboardShellSkeleton />;
  }

  // Error state
  if (error) {
    return (
      <AccessCard Icon={AlertTriangle} title="Something went wrong" tone="red">
        <p className="text-zinc-600">
          {error.message || "Failed to load dashboard"}
        </p>
        <button
          onClick={() => window.location.reload()}
          className="mt-6 px-6 py-2.5 bg-zinc-900 text-white rounded-lg font-medium hover:bg-zinc-800 transition-colors"
        >
          Try Again
        </button>
      </AccessCard>
    );
  }

  if (!userDetails) {
    return <PersonalDashboardShellSkeleton />;
  }

  const userName = userDetails.name ?? session?.user?.name ?? null;
  const userImage = userDetails.image ?? session?.user?.image ?? null;

  // Bottom chip dropdown — account pages + org context switching (matches
  // the consultant/org shells' IA); Sign Out renders as the standalone red
  // button below the chip.
  const bottomUserChipActions = [
    {
      type: "item" as const,
      label: "Settings",
      href: `${basePath}/settings`,
      icon: Settings,
    },
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

  return (
    <NovuProvider>
      <UserProvider userDetails={userDetails}>
        <PersonalDashboardShell
          groups={NAV_GROUPS}
          basePath={basePath}
          title="My Dashboard"
          subtitle={userName}
          headerImage={userImage}
          bottomUserChip={{
            name: userName,
            image: userImage,
            role: "Client",
          }}
          bottomUserChipActions={bottomUserChipActions}
          contextBar={{
            identity: {
              name: userName ?? "My Dashboard",
              image: userImage,
              FallbackIcon: UserRound,
            },
            breadcrumbs,
          }}
          mobileTabs={MOBILE_TABS}
          pathname={pathname}
          onSignOut={() => void signOutEverywhere()}
        >
          {memoizedStreamContent}
        </PersonalDashboardShell>
      </UserProvider>
    </NovuProvider>
  );
}
