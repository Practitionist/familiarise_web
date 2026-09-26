"use client";

import { use, useMemo } from "react";
import { motion } from "framer-motion";
import {
  UserX,
  Lock,
  WifiOff,
  AlertTriangle,
  type LucideIcon,
} from "lucide-react";

import { BreadcrumbOverrideProvider } from "@/components/dashboard/breadcrumb-override";
import {
  PersonalDashboardLayoutCore,
  type PersonalDashboardExtras,
  type PersonalDashboardExtrasCtx,
  type PersonalDashboardUser,
} from "@/components/dashboard/PersonalDashboardLayoutCore";
import { consultantFetchers } from "@/lib/dashboard-queries";
import {
  buildConsultantNav,
  CONSULTANT_OFFERING_TYPE_SEGMENTS,
  CONSULTANT_PAGE_LABELS,
  CONSULTANT_PATHLESS_SEGMENTS,
} from "@/lib/dashboard/nav/consultant";
import { useChatUnreadCount } from "@/hooks/useChatUnreadCount";
import { verificationStatusBadge } from "@/lib/labels/session-labels";
import {
  VerificationPendingOverlay,
  VerificationBanner,
} from "@/components/verification/VerificationPendingOverlay";
import type { VerificationStatus } from "@/components/verification/VerificationStatusBadge";
import { useVerificationStatus } from "./hooks/useVerificationStatus";

const PREFETCH_SUFFIXES = ["home", "appointments", "requests"];

// Offerings have no list route yet (#1527 b) — the planner hosts them.
const OFFERINGS_CRUMBS = {
  typeSegments: CONSULTANT_OFFERING_TYPE_SEGMENTS,
  listingHref: "planner",
};

interface PageProps {
  children: React.ReactNode;
  params: Promise<{ consultantId: string }>;
}

// Error types and their configurations
type ErrorType = "not-found" | "session-expired" | "network" | "unknown";

function getErrorConfig(errorMessage: string): {
  type: ErrorType;
  title: string;
  description: string;
  suggestion: string;
  primaryAction: { label: string; href?: string; onClick?: () => void };
  secondaryAction?: { label: string; href: string };
} {
  const lowerMessage = errorMessage.toLowerCase();

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

const ERROR_ICONS: Record<
  ErrorType,
  { Icon: LucideIcon; bg: string; color: string }
> = {
  "not-found": { Icon: UserX, bg: "bg-amber-100", color: "text-amber-600" },
  "session-expired": { Icon: Lock, bg: "bg-blue-100", color: "text-blue-600" },
  network: { Icon: WifiOff, bg: "bg-orange-100", color: "text-orange-600" },
  unknown: { Icon: AlertTriangle, bg: "bg-red-100", color: "text-red-600" },
};

function ErrorDisplay({ message }: { message: string }) {
  const config = getErrorConfig(message);
  const { Icon, bg, color } = ERROR_ICONS[config.type];

  return (
    <div className="flex items-center justify-center min-h-svh bg-zinc-100">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white p-8 rounded-2xl shadow-xl border border-zinc-200 max-w-md text-center mx-4"
      >
        <div
          className={`w-16 h-16 mx-auto mb-4 rounded-full ${bg} flex items-center justify-center`}
        >
          <Icon className={`w-8 h-8 ${color}`} />
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

// Profile payload as the layout consumes it: the composed consultant record
// (user identity + verification status). The fetcher returns the API shape;
// the accessors below read it structurally.
interface ConsultantDetails {
  user?: {
    id?: string;
    name?: string | null;
    image?: string | null;
  } | null;
  verificationStatus?: VerificationStatus;
}

async function fetchConsultantUser(
  userId: string,
): Promise<PersonalDashboardUser | null> {
  const response = await fetch(`/api/user/${userId}`);
  if (!response.ok) throw new Error("Failed to fetch user details");
  const result = await response.json();
  return result.data as PersonalDashboardUser | null;
}

// Verification state + reviewer feedback as shell extras. The consultant-data
// payload carries the coarse status; the verification query adds the latest
// submission's rejectionReason / feedbackDetails / per-document feedback so
// the REJECTED gate can finally show WHY. ADMIN/STAFF inspecting someone's
// dashboard are never gated (and /api/verification/status reads the signed-in
// user, which would be the admin's own — mismatched — record).
function useConsultantExtras({
  profile,
  userDetails,
  userId,
  routeParam,
  basePath,
  pathname,
}: PersonalDashboardExtrasCtx<ConsultantDetails>): PersonalDashboardExtras {
  const verificationStatus = profile?.verificationStatus ?? undefined;
  const isOwnDashboard = userDetails?.consultantProfileId === routeParam;
  const { data: verification } = useVerificationStatus(
    userId,
    !!verificationStatus &&
      verificationStatus !== "VERIFIED" &&
      !!isOwnDashboard,
  );

  const verificationHref = `${basePath}/settings/verification`;
  // Gating policy: waiting states get a browsable dashboard + banner;
  // REJECTED gets the full-screen gate with the reviewer feedback threaded
  // in. Settings stays reachable in every state (it hosts the fix).
  const isSettingsPage = pathname.includes("/settings");
  const showRejectedGate =
    verificationStatus === "REJECTED" && !isSettingsPage && !!isOwnDashboard;
  const showVerificationBanner =
    (verificationStatus === "PENDING_VERIFICATION" ||
      verificationStatus === "UNDER_REVIEW") &&
    !isSettingsPage &&
    !!isOwnDashboard;

  return {
    overlay: showRejectedGate ? (
      <VerificationPendingOverlay
        status="REJECTED"
        rejectionReason={
          verification?.latestRequest?.rejectionReason ?? undefined
        }
        feedbackDetails={
          verification?.latestRequest?.feedbackDetails ?? undefined
        }
        documentFeedback={verification?.latestRequest?.documentFeedback}
        resubmitUrl={verificationHref}
      />
    ) : undefined,
    banner:
      showVerificationBanner && verificationStatus ? (
        <VerificationBanner
          status={verificationStatus}
          resubmitUrl={verificationHref}
        />
      ) : undefined,
    badges: verificationStatus
      ? [
          {
            label: verificationStatusBadge(verificationStatus).label,
            className: verificationStatusBadge(verificationStatus).className,
          },
        ]
      : [],
  };
}

export default function ConsultantLayout(props: Readonly<PageProps>) {
  return (
    <BreadcrumbOverrideProvider>
      <ConsultantLayoutInner {...props} />
    </BreadcrumbOverrideProvider>
  );
}

function ConsultantLayoutInner({ children, params }: Readonly<PageProps>) {
  const { consultantId } = use(params);
  const nav = useMemo(() => buildConsultantNav(consultantId), [consultantId]);

  // Unread badge count for the Messages nav item
  const chatUnreadCount = useChatUnreadCount();
  const badges = useMemo(
    () => ({ messages: chatUnreadCount }),
    [chatUnreadCount],
  );

  return (
    <PersonalDashboardLayoutCore<ConsultantDetails>
      routeParam={consultantId}
      nav={nav}
      badges={badges}
      chipRole="Expert"
      identityFallbackName="Expert"
      pageLabels={CONSULTANT_PAGE_LABELS}
      pathlessSegments={CONSULTANT_PATHLESS_SEGMENTS}
      offeringsConfig={OFFERINGS_CRUMBS}
      fetchUser={fetchConsultantUser}
      profileQueryKey={["consultant-data", consultantId]}
      fetchProfile={() =>
        consultantFetchers.details(
          consultantId,
        ) as Promise<ConsultantDetails | null>
      }
      profileStreamUserId={(profile) => profile?.user?.id}
      profileDisplayName={(profile) => profile?.user?.name}
      profileDisplayImage={(profile) => profile?.user?.image}
      hasAccess={(user) =>
        !!user &&
        (user.role === "ADMIN" ||
          user.role === "STAFF" ||
          user.consultantProfileId === consultantId)
      }
      resolveRedirectTarget={(user) => {
        if (user.consultantProfileId) {
          return `/dashboard/consultant/${user.consultantProfileId}/home`;
        }
        if (user.consulteeProfileId) {
          return `/dashboard/consultee/${user.consulteeProfileId}/home`;
        }
        return "/dashboard";
      }}
      prefetchSuffixes={PREFETCH_SUFFIXES}
      renderError={(message) => <ErrorDisplay message={message} />}
      useExtras={useConsultantExtras}
    >
      {children}
    </PersonalDashboardLayoutCore>
  );
}
