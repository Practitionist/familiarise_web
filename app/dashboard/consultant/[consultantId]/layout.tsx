"use client";

import { getEffectiveUserId } from "@/utils/auth";
import { Skeleton } from "@/components/ui/skeleton";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import StreamProvider from "@/providers/StreamProvider";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import NovuProvider from "@/providers/NovuProvider";
import { NotificationInbox } from "@/components/notifications/NotificationInbox";
import { useNovuSubscriberSync } from "@/hooks/useNovuSubscriberSync";
import {
  DashboardSidebar,
  type NavSection,
} from "@/components/dashboard/DashboardSidebar";
import { DashboardNavbar } from "@/components/dashboard/DashboardNavbar";
import { useSession } from "@/lib/auth-client";
import { usePathname, useRouter } from "next/navigation";
import { use, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { consultantFetchers, schedulePrefetch } from "@/lib/dashboard-queries";
import { motion } from "framer-motion";
import { VerificationPendingOverlay } from "@/components/verification/VerificationPendingOverlay";
import type { VerificationStatus } from "@/components/verification/VerificationStatusBadge";

// Navigation configuration - grouped sections
const NAV_SECTIONS: NavSection[] = [
  {
    title: null,
    items: [
      { name: "Home", path: "home", icon: "home" },
      { name: "Chats", path: "chats", icon: "chats" },
      { name: "Appointments", path: "appointments", icon: "appointments" },
    ],
  },
  {
    title: "Services",
    items: [
      { name: "Event Planner", path: "planner", icon: "planner" },
      { name: "Requests", path: "requests", icon: "requests" },
      { name: "Collaborations", path: "collaborations", icon: "users" },
      { name: "Free Trials", path: "trials", icon: "trials" },
    ],
  },
  {
    title: "Content",
    items: [
      { name: "Recordings", path: "recordings", icon: "recordings" },
      { name: "Documents", path: "documents", icon: "documents" },
    ],
  },
  {
    title: "Finance",
    items: [
      { name: "Earnings", path: "earnings", icon: "wallet" },
      { name: "Referrals", path: "referrals", icon: "gift" },
    ],
  },
];

interface PageProps {
  children: React.ReactNode;
  params: Promise<{ consultantId: string }>;
}

// Error types and their configurations
type ErrorType =
  | "not-found"
  | "session-expired"
  | "no-profile"
  | "network"
  | "unknown";

function getErrorConfig(errorMessage: string): {
  type: ErrorType;
  title: string;
  description: string;
  suggestion: string;
  primaryAction: { label: string; href?: string; onClick?: () => void };
  secondaryAction?: { label: string; href: string };
} {
  const lowerMessage = errorMessage.toLowerCase();

  // Profile not found - user might not have a consultant profile
  if (lowerMessage.includes("not found") || lowerMessage.includes("404")) {
    return {
      type: "not-found",
      title: "Profile Not Found",
      description:
        "We couldn't find your consultant profile. This might happen if you're logged into the wrong account or your profile hasn't been set up yet.",
      suggestion:
        "Try signing out and logging back in with the correct account.",
      primaryAction: {
        label: "Sign Out & Re-login",
        href: "/auth/signin?callbackUrl=/dashboard",
      },
      secondaryAction: { label: "Go to Home", href: "/" },
    };
  }

  // Session expired or unauthorized
  if (
    lowerMessage.includes("unauthorized") ||
    lowerMessage.includes("401") ||
    lowerMessage.includes("session")
  ) {
    return {
      type: "session-expired",
      title: "Session Expired",
      description:
        "Your session has expired or you've been signed out. Please sign in again to continue.",
      suggestion: "This is normal after being inactive for a while.",
      primaryAction: {
        label: "Sign In Again",
        href: "/auth/signin?callbackUrl=/dashboard",
      },
    };
  }

  // Network or server error
  if (
    lowerMessage.includes("network") ||
    lowerMessage.includes("fetch") ||
    lowerMessage.includes("500")
  ) {
    return {
      type: "network",
      title: "Connection Issue",
      description:
        "We're having trouble connecting to our servers. This is usually temporary.",
      suggestion: "Check your internet connection and try again.",
      primaryAction: {
        label: "Try Again",
        onClick: () => window.location.reload(),
      },
    };
  }

  // Default/unknown error
  return {
    type: "unknown",
    title: "Something Went Wrong",
    description: "We encountered an unexpected issue loading your dashboard.",
    suggestion:
      "If this keeps happening, try signing out and back in, or contact support.",
    primaryAction: {
      label: "Sign Out & Re-login",
      href: "/auth/signin?callbackUrl=/dashboard",
    },
    secondaryAction: { label: "Try Again", href: "#" },
  };
}

// Error display component
function ErrorDisplay({ message }: { message: string }) {
  const config = getErrorConfig(message);

  const iconColors = {
    "not-found": { bg: "bg-amber-100", icon: "text-amber-600" },
    "session-expired": { bg: "bg-blue-100", icon: "text-blue-600" },
    "no-profile": { bg: "bg-purple-100", icon: "text-purple-600" },
    network: { bg: "bg-orange-100", icon: "text-orange-600" },
    unknown: { bg: "bg-red-100", icon: "text-red-600" },
  };

  const colors = iconColors[config.type];

  return (
    <div className="flex items-center justify-center min-h-screen bg-zinc-100">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white p-8 rounded-2xl shadow-xl border border-zinc-200 max-w-md text-center mx-4"
      >
        <div
          className={`w-16 h-16 mx-auto mb-4 rounded-full ${colors.bg} flex items-center justify-center`}
        >
          {config.type === "not-found" || config.type === "no-profile" ? (
            <svg
              className={`w-8 h-8 ${colors.icon}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
              />
            </svg>
          ) : config.type === "session-expired" ? (
            <svg
              className={`w-8 h-8 ${colors.icon}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
              />
            </svg>
          ) : config.type === "network" ? (
            <svg
              className={`w-8 h-8 ${colors.icon}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0"
              />
            </svg>
          ) : (
            <svg
              className={`w-8 h-8 ${colors.icon}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          )}
        </div>

        <h2 className="text-xl font-bold text-zinc-900 mb-2">{config.title}</h2>
        <p className="text-zinc-600 mb-3">{config.description}</p>
        <p className="text-sm text-zinc-500 italic mb-6">{config.suggestion}</p>

        <div className="flex flex-col gap-3">
          {config.primaryAction.href ? (
            <a
              href={config.primaryAction.href}
              className="w-full px-6 py-2.5 bg-zinc-900 text-white rounded-lg font-medium hover:bg-zinc-800 transition-colors"
            >
              {config.primaryAction.label}
            </a>
          ) : (
            <button
              onClick={config.primaryAction.onClick}
              className="w-full px-6 py-2.5 bg-zinc-900 text-white rounded-lg font-medium hover:bg-zinc-800 transition-colors"
            >
              {config.primaryAction.label}
            </button>
          )}

          {config.secondaryAction && (
            <a
              href={config.secondaryAction.href}
              onClick={
                config.secondaryAction.href === "#"
                  ? (e) => {
                      e.preventDefault();
                      window.location.reload();
                    }
                  : undefined
              }
              className="w-full px-6 py-2.5 bg-zinc-100 text-zinc-700 rounded-lg font-medium hover:bg-zinc-200 transition-colors"
            >
              {config.secondaryAction.label}
            </a>
          )}
        </div>
      </motion.div>
    </div>
  );
}

// Auth required component
function AuthRequired() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-zinc-100">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white p-8 rounded-2xl shadow-xl border border-zinc-200 max-w-md text-center"
      >
        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-amber-100 flex items-center justify-center">
          <svg
            className="w-8 h-8 text-amber-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
            />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-zinc-900 mb-2">
          Authentication Required
        </h2>
        <p className="text-zinc-600">
          Please sign in to access your dashboard.
        </p>
        <a
          href="/auth/signin"
          className="inline-block mt-6 px-6 py-2.5 bg-zinc-900 text-white rounded-lg font-medium hover:bg-zinc-800 transition-colors"
        >
          Sign In
        </a>
      </motion.div>
    </div>
  );
}

// Loading skeleton for initial load
function DashboardSkeleton() {
  return (
    <div className="flex min-h-screen bg-zinc-100">
      {/* Sidebar skeleton */}
      <aside className="fixed left-0 top-0 z-40 hidden h-screen w-64 bg-zinc-950 lg:block">
        <div className="flex h-16 items-center gap-3 border-b border-zinc-800/50 px-6">
          <Skeleton className="h-9 w-9 rounded-lg bg-zinc-800" />
          <Skeleton className="h-5 w-24 bg-zinc-800" />
        </div>
        <div className="border-b border-zinc-800/50 p-4">
          <div className="flex items-center gap-3">
            <Skeleton className="h-12 w-12 rounded-full bg-zinc-800" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-28 bg-zinc-800" />
              <Skeleton className="h-3 w-20 bg-zinc-800" />
            </div>
          </div>
        </div>
        <div className="p-3 space-y-1">
          {[1, 2, 3, 4, 5, 6, 7].map((i) => (
            <Skeleton key={i} className="h-11 w-full rounded-lg bg-zinc-800" />
          ))}
        </div>
      </aside>

      {/* Main content skeleton */}
      <main className="flex-1 lg:ml-64 p-8">
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-2">
              <Skeleton className="h-8 w-48 bg-zinc-200" />
              <Skeleton className="h-4 w-64 bg-zinc-200" />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-32 rounded-xl bg-white" />
            ))}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Skeleton className="lg:col-span-2 h-96 rounded-xl bg-white" />
            <Skeleton className="h-96 rounded-xl bg-white" />
          </div>
        </div>
      </main>
    </div>
  );
}

// Main layout component
export default function ConsultantLayout({
  children,
  params,
}: Readonly<PageProps>) {
  const resolvedParams = use(params);
  const consultantId = resolvedParams.consultantId;
  const pathname = usePathname();
  const { data: session, isPending: isSessionLoading } = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();

  const userId = getEffectiveUserId(session);

  // Sync user as Novu subscriber (once per session)
  useNovuSubscriberSync();

  // Fetch user details to check consultant access
  const { data: userDetails, isLoading: isLoadingUserDetails } = useQuery({
    queryKey: ["user-details", userId],
    queryFn: async () => {
      const response = await fetch(`/api/user/${userId}`);
      if (!response.ok) throw new Error("Failed to fetch user details");
      const result = await response.json();
      return result.data;
    },
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
  });

  // Fetch consultant data with React Query and placeholderData to prevent loading flashes
  const {
    data: consultantData,
    error,
    isLoading,
  } = useQuery({
    queryKey: ["consultant-data", consultantId],
    queryFn: () => consultantFetchers.details(consultantId),
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
    placeholderData: (previousData) => previousData, // Keep showing previous data while refetching
  });

  // Check if user has access to this consultant dashboard:
  // - ADMIN: Can access ANY dashboard
  // - STAFF: Can view consultant and consultee dashboards
  // - CONSULTANT: Can only access their OWN dashboard
  const hasConsultantAccess =
    userDetails &&
    (userDetails.role === "ADMIN" ||
      userDetails.role === "STAFF" ||
      (userDetails.role === "CONSULTANT" &&
        userDetails.consultantProfileId === consultantId));

  // Redirect unauthorized users to their appropriate dashboard
  useEffect(() => {
    if (isLoadingUserDetails || isSessionLoading || !userId) return;

    if (userDetails && !hasConsultantAccess) {
      // User doesn't have access - redirect based on their role
      if (userDetails.consultantProfileId) {
        // Consultant trying to access another consultant's dashboard - redirect to their own
        router.replace(
          `/dashboard/consultant/${userDetails.consultantProfileId}/home`,
        );
      } else if (userDetails.consulteeProfileId) {
        router.replace(
          `/dashboard/consultee/${userDetails.consulteeProfileId}/home`,
        );
      } else {
        router.replace("/dashboard");
      }
    }
  }, [
    userDetails,
    hasConsultantAccess,
    isLoadingUserDetails,
    isSessionLoading,
    userId,
    router,
  ]);

  // Prefetch critical routes on mount
  useEffect(() => {
    if (!userId || !consultantId || !hasConsultantAccess) return;

    schedulePrefetch(() => {
      // Prefetch home route if not there
      if (!pathname.includes("/home")) {
        router.prefetch(`/dashboard/consultant/${consultantId}/home`);
      }
      // Prefetch appointments (commonly accessed)
      router.prefetch(`/dashboard/consultant/${consultantId}/appointments`);
    }, 3000);
  }, [userId, consultantId, pathname, router, hasConsultantAccess]);

  // Memoize StreamProvider children to prevent re-initialization on tab switches
  // Must be called before any early returns to comply with Rules of Hooks
  const memoizedStreamContent = useMemo(
    () =>
      consultantData?.user?.id ? (
        <StreamProvider
          userId={consultantData.user.id}
          enableChat={true}
          enableVideo={true}
        >
          <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
        </StreamProvider>
      ) : (
        <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
      ),
    [consultantData?.user?.id, children],
  );

  // Authentication check
  if (
    process.env.NODE_ENV !== "development" &&
    process.env.NODE_ENV !== "test" &&
    !session?.user?.id &&
    !isSessionLoading
  ) {
    return <AuthRequired />;
  }

  // ACCESS DENIED CHECK - BEFORE skeleton to avoid showing skeleton for unauthorized users
  // If we have user details but no access, show redirect message immediately
  if (userDetails && !hasConsultantAccess) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-zinc-100">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white p-8 rounded-2xl shadow-xl border border-zinc-200 max-w-md text-center"
        >
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-amber-100 flex items-center justify-center">
            <svg
              className="w-8 h-8 text-amber-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
              />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-zinc-900 mb-2">
            Access Denied
          </h2>
          <p className="text-zinc-600">
            You don&apos;t have permission to access this Consultant Dashboard.
          </p>
          <p className="text-sm text-zinc-500 mt-2">
            Redirecting to your dashboard...
          </p>
        </motion.div>
      </div>
    );
  }

  // Initial loading state - only show if we don't have userDetails yet (still determining access)
  if (
    (isLoading || isLoadingUserDetails || isSessionLoading) &&
    !consultantData &&
    !userDetails
  ) {
    return <DashboardSkeleton />;
  }

  // Error state
  if (error && !consultantData) {
    return (
      <ErrorDisplay
        message={
          error instanceof Error ? error.message : "Failed to load dashboard"
        }
      />
    );
  }

  // Build sidebar
  const sidebar = (
    <DashboardSidebar
      userImage={consultantData?.user?.image}
      userName={consultantData?.user?.name}
      userRole="CONSULTANT"
      basePath={`/dashboard/consultant/${consultantId}`}
      navSections={NAV_SECTIONS}
      hideBottomActions={true}
      isLoading={isLoading}
    />
  );

  // Build top navbar
  const navbar = (
    <DashboardNavbar
      userName={consultantData?.user?.name}
      userImage={consultantData?.user?.image}
      userRole="CONSULTANT"
      settingsPath={`/dashboard/consultant/${consultantId}/settings`}
      helpPath={`/dashboard/consultant/${consultantId}/help`}
    />
  );

  // Check verification status - don't block settings page
  const isSettingsPage = pathname.includes("/settings");
  const verificationStatus = consultantData?.verificationStatus as
    | VerificationStatus
    | undefined;
  const isVerified = verificationStatus === "VERIFIED";
  const showVerificationOverlay =
    !isVerified && verificationStatus && !isSettingsPage;

  return (
    <NovuProvider>
      {showVerificationOverlay && (
        <VerificationPendingOverlay
          status={verificationStatus}
          resubmitUrl={`/dashboard/consultant/${consultantId}/settings`}
        />
      )}
      <DashboardShell
        sidebar={sidebar}
        navbar={navbar}
        headerActions={<NotificationInbox />}
      >
        {memoizedStreamContent}
      </DashboardShell>
    </NovuProvider>
  );
}
