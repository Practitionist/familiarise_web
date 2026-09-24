"use client";

import { use, useMemo } from "react";
import { motion } from "framer-motion";
import {
  Home,
  MessageSquare,
  CalendarCheck,
  CalendarClock,
  CalendarRange,
  Inbox,
  Users,
  Video,
  FileText,
  Wallet,
  Gift,
  Settings,
  MessageSquareText,
  HelpCircle,
  LifeBuoy,
  UserX,
  Lock,
  WifiOff,
  AlertTriangle,
  type LucideIcon,
} from "lucide-react";

import type { CollapsibleSidebarGroup } from "@/components/dashboard/CollapsibleSidebar";
import { BreadcrumbOverrideProvider } from "@/components/dashboard/breadcrumb-override";
import {
  PersonalDashboardLayoutCore,
  type PersonalDashboardExtras,
  type PersonalDashboardExtrasCtx,
  type PersonalDashboardUser,
} from "@/components/dashboard/PersonalDashboardLayoutCore";
import { consultantFetchers } from "@/lib/dashboard-queries";
import { useChatUnreadCount } from "@/hooks/useChatUnreadCount";
import { verificationStatusBadge } from "@/lib/labels/session-labels";
import {
  VerificationPendingOverlay,
  VerificationBanner,
} from "@/components/verification/VerificationPendingOverlay";
import type { VerificationStatus } from "@/components/verification/VerificationStatusBadge";
import { useVerificationStatus } from "./hooks/useVerificationStatus";

// Grouped sidebar nav (Services / Resources / Finance / Support), rendered by
// the shared CollapsibleSidebar.
//
// Trials and Analytics used to be entries here and are now tabs on Appointments
// and Earnings respectively — see the group comments below. This array is still
// static and unfiltered, unlike the org sidebar's permission-driven one: every
// surface on a personal dashboard belongs to the one person who owns it, so
// there is nothing to filter on.
const NAV_GROUPS: CollapsibleSidebarGroup[] = [
  {
    items: [
      { name: "Home", icon: Home, path: "home" },
      { name: "Messages", icon: MessageSquare, path: "messages" },
      { name: "Appointments", icon: CalendarCheck, path: "appointments" },
    ],
  },
  {
    // Trials is absent by ADR 19's rule that a nav entry must be a distinct
    // destination: a trial IS an appointment, which is why the org sidebar
    // already folded it onto Appointments. It lives at
    // `appointments?tab=trials` now.
    label: "Services",
    items: [
      { name: "Event Planner", icon: CalendarRange, path: "planner" },
      // #1785 — Availability is a daily work surface, not a preference, so it
      // left Settings for the sidebar (where Calendly and Cal.com keep it too).
      { name: "Availability", icon: CalendarClock, path: "availability" },
      { name: "Requests", icon: Inbox, path: "requests" },
      { name: "Collaborations", icon: Users, path: "collaborations" },
    ],
  },
  {
    // "Resources" rather than "Content", matching the consultee side — the
    // same two artifacts under the same name on both dashboards, so a
    // consultant who also books sessions is not learning two vocabularies.
    label: "Resources",
    items: [
      { name: "Documents", icon: FileText, path: "documents" },
      { name: "Recordings", icon: Video, path: "recordings" },
    ],
  },
  {
    // Analytics is absent for the same reason as Trials: it read the very same
    // /api/consultant/earnings endpoint as Earnings, only adding
    // `?includeMonthly=1`. Two entries over one object is exactly what ADR 19
    // forbids, so it is the Analytics tab of Earnings now.
    label: "Finance",
    items: [
      { name: "Earnings", icon: Wallet, path: "earnings" },
      { name: "Referrals", icon: Gift, path: "referrals" },
    ],
  },
  {
    // A real group now rather than a lone entry: requests, feedback and help
    // were tabs on one page and are distinct destinations. Settings joins them
    // as the fourth — the other thing people go looking for when something is
    // wrong. Mirrors the consultee shell exactly.
    label: "Support",
    items: [
      { name: "Support requests", icon: LifeBuoy, path: "support" },
      { name: "Feedback", icon: MessageSquareText, path: "feedback" },
      { name: "Help", icon: HelpCircle, path: "help" },
      { name: "Settings", icon: Settings, path: "settings" },
    ],
  },
];

// Mobile bottom-tab configuration — 5 most-accessed consultant pages. Five is
// the cap; Availability stays reachable from the sidebar drawer (#1785).
const MOBILE_TABS: { label: string; path: string; Icon: LucideIcon }[] = [
  { label: "Home", path: "home", Icon: Home },
  { label: "Appointments", path: "appointments", Icon: CalendarCheck },
  { label: "Requests", path: "requests", Icon: Inbox },
  { label: "Earnings", path: "earnings", Icon: Wallet },
  { label: "Settings", path: "settings", Icon: Settings },
];

// Map URL segments to human-readable page names so the breadcrumbs match
// the heading the user actually sees on the page.
const PAGE_LABELS: Record<string, string> = {
  home: "Home",
  messages: "Messages",
  appointments: "Appointments",
  participants: "Participants",
  classes: "Class",
  class: "Class",
  consultations: "Consultation",
  consultation: "Consultation",
  subscriptions: "Subscription",
  subscription: "Subscription",
  webinars: "Webinar",
  webinar: "Webinar",
  offerings: "Offerings",
  planner: "Event Planner",
  availability: "Availability",
  requests: "Requests",
  // Task routes hanging off a record id. Without these the trail ends on the
  // raw lowercase segment ("timings").
  timings: "Timings",
  allocate: "Allocate",
  reschedule: "Reschedule",
  collaborations: "Collaborations",
  recordings: "Recordings",
  documents: "Documents",
  earnings: "Earnings",
  referrals: "Referrals",
  settings: "Settings",
  // The Settings hub's sections (#1785): one URL each, so one crumb each.
  profile: "Profile",
  verification: "Verification",
  booking: "Booking requests",
  "get-paid": "Get paid",
  payouts: "Get paid",
  notifications: "Notifications",
  security: "Security",
  support: "Support requests",
  feedback: "Feedback",
  help: "Help",
  edit: "Edit",
  new: "New",
};

// Segments that group routes without owning a page of their own — a crumb that
// links the accumulated path makes Next prefetch a URL that 404s. Verified
// against the route tree: `offerings` has only `[type]/…` children and
// `participants` only `[eventType]/…`.
//
// Offerings is special-cased in the core: the crumb stays, but its href is
// rewritten to the Event Planner, which is the actual listings surface.
const PATHLESS_SEGMENTS = new Set(["offerings", "participants"]);

/** Offering types that appear as `/offerings/[type]/…` URL segments. */
const OFFERING_TYPE_SEGMENTS = new Set([
  "consultation",
  "subscription",
  "webinar",
  "class",
]);

const PREFETCH_SUFFIXES = ["home", "appointments", "requests"];

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
  const basePath = `/dashboard/consultant/${consultantId}`;

  // Unread badge count for the Messages nav item
  const chatUnreadCount = useChatUnreadCount();
  const navGroups = useMemo(
    () =>
      NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.map((item) =>
          item.path === "messages" && chatUnreadCount > 0
            ? {
                ...item,
                badge: chatUnreadCount > 99 ? "99+" : chatUnreadCount,
              }
            : item,
        ),
      })),
    [chatUnreadCount],
  );

  return (
    <PersonalDashboardLayoutCore<ConsultantDetails>
      routeParam={consultantId}
      basePath={basePath}
      title="Consultant Dashboard"
      chipRole="Consultant"
      identityFallbackName="Consultant"
      navGroups={navGroups}
      mobileTabs={MOBILE_TABS}
      pageLabels={PAGE_LABELS}
      pathlessSegments={PATHLESS_SEGMENTS}
      offeringsConfig={{
        typeSegments: OFFERING_TYPE_SEGMENTS,
        listingHref: "planner",
      }}
      fetchUser={fetchConsultantUser}
      profileQueryKey={["consultant-data", consultantId]}
      fetchProfile={() =>
        consultantFetchers.details(consultantId) as Promise<
          ConsultantDetails | null
        >
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
