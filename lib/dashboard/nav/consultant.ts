import {
  CalendarCheck,
  CalendarClock,
  CalendarRange,
  ExternalLink,
  FileText,
  Gift,
  Home,
  Inbox,
  LifeBuoy,
  MessageSquare,
  Settings,
  Star,
  Video,
  Wallet,
} from "lucide-react";

import type { DashboardNav } from "./types";

/**
 * Expert (consultant) IA from #1527 §7.2. Collaborations is a tab of
 * Offerings, and Reviews (Q5) closes the Business group.
 */
export function buildConsultantNav(consultantId: string): DashboardNav {
  const publicHref = `/explore/experts/${consultantId}`;
  return {
    basePath: `/dashboard/consultant/${consultantId}`,
    groups: [
      {
        label: "Work",
        items: [
          { name: "Home", icon: Home, path: "home" },
          {
            name: "Requests",
            icon: Inbox,
            path: "requests",
            badgeKey: "requests",
          },
          { name: "Appointments", icon: CalendarCheck, path: "appointments" },
          {
            name: "Messages",
            icon: MessageSquare,
            path: "messages",
            badgeKey: "messages",
          },
        ],
      },
      {
        label: "Business",
        items: [
          { name: "Offerings", icon: CalendarRange, path: "offerings" },
          // #1785 — a daily work surface, not a preference.
          { name: "Availability", icon: CalendarClock, path: "availability" },
          { name: "Earnings", icon: Wallet, path: "earnings" },
          { name: "Reviews", icon: Star, path: "reviews" },
        ],
      },
      {
        label: "Library",
        items: [
          { name: "Documents", icon: FileText, path: "documents" },
          { name: "Recordings", icon: Video, path: "recordings" },
        ],
      },
      {
        label: "Grow",
        items: [{ name: "Invite & earn", icon: Gift, path: "referrals" }],
      },
    ],
    utility: [
      { name: "Help & support", icon: LifeBuoy, path: "support" },
      { name: "Settings", icon: Settings, path: "settings" },
    ],
    mobileTabs: ["home", "requests", "appointments", "messages"],
    pinnedCta: {
      label: "View public page",
      href: publicHref,
      icon: ExternalLink,
      copyText: publicHref,
    },
  };
}

export const CONSULTANT_PAGE_LABELS: Record<string, string> = {
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
  availability: "Availability",
  requests: "Requests",
  timings: "Timings",
  allocate: "Allocate",
  reschedule: "Reschedule",
  collaborations: "Collaborations",
  reviews: "Reviews",
  recordings: "Recordings",
  documents: "Documents",
  earnings: "Earnings",
  referrals: "Invite & earn",
  settings: "Settings",
  // Settings hub sections (#1785): one URL each, so one crumb each.
  profile: "Profile",
  experience: "Experience & education",
  verification: "Verification",
  booking: "Booking requests",
  "get-paid": "Get paid",
  payouts: "Get paid",
  notifications: "Notifications",
  security: "Security",
  support: "Help & support",
  feedback: "Feedback",
  help: "Help",
  edit: "Edit",
  new: "New",
};

// `participants` has only `[eventType]/…` children — linking its crumb would
// prefetch a 404.
export const CONSULTANT_PATHLESS_SEGMENTS: ReadonlySet<string> = new Set([
  "participants",
]);

export const CONSULTANT_OFFERING_TYPE_SEGMENTS: ReadonlySet<string> = new Set([
  "consultation",
  "subscription",
  "webinar",
  "class",
]);
