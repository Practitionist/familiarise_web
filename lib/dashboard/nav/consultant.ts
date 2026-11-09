import {
  CalendarCheck,
  CalendarClock,
  ExternalLink,
  FileText,
  Gift,
  Handshake,
  Home,
  Inbox,
  Library,
  LifeBuoy,
  MessageSquare,
  Package,
  Settings,
  Star,
  UserRound,
  UsersRound,
  Video,
  Wallet,
} from "lucide-react";

import { SellableKindSchema } from "../sell-pages";
import { personalSupportLinks, type DashboardNav } from "./types";

/**
 * Expert IA: Sell is what the expert offers, Studio what they made in
 * sessions, and My library what they bought.
 */
export function buildConsultantNav(consultantId: string): DashboardNav {
  const publicHref = `/explore/experts/${consultantId}`;
  const basePath = `/dashboard/consultant/${consultantId}`;
  return {
    basePath,
    groups: [
      { items: [{ name: "Home", icon: Home, path: "home" }] },
      {
        label: "Inbox",
        items: [
          {
            name: "Booking requests",
            icon: Inbox,
            path: "requests",
            badgeKey: "requests",
          },
          {
            name: "Messages",
            icon: MessageSquare,
            path: "messages",
            badgeKey: "messages",
          },
          { name: "Collaborations", icon: Handshake, path: "collaborations" },
        ],
      },
      {
        label: "Calendar",
        items: [
          { name: "Appointments", icon: CalendarCheck, path: "appointments" },
          { name: "Availability", icon: CalendarClock, path: "availability" },
        ],
      },
      {
        label: "Sell",
        items: [
          {
            name: "1:1 & subscriptions",
            icon: UserRound,
            path: "sell/sessions",
          },
          { name: "Group programs", icon: UsersRound, path: "sell/programs" },
        ],
      },
      {
        label: "Studio",
        items: [
          { name: "Recordings", icon: Video, path: "recordings" },
          { name: "Session documents", icon: FileText, path: "documents" },
          { name: "Products", icon: Package, path: "products" },
        ],
      },
      {
        label: "Money",
        items: [
          { name: "Earnings & payouts", icon: Wallet, path: "earnings" },
          { name: "Invite & earn", icon: Gift, path: "referrals" },
        ],
      },
      {
        label: "Reputation",
        items: [{ name: "Reviews", icon: Star, path: "reviews" }],
      },
      // The expert as a buyer: purchases, plus attended sessions when they
      // also hold a learner profile.
      { items: [{ name: "My library", icon: Library, path: "library" }] },
      {
        label: "Settings & help",
        items: [
          { name: "Help & support", icon: LifeBuoy, path: "support" },
          { name: "Settings", icon: Settings, path: "settings" },
        ],
      },
    ],
    support: personalSupportLinks(`${basePath}/support`),
    mobileTabs: ["home", "requests", "appointments", "messages"],
    pinnedCta: {
      label: "View public page",
      href: publicHref,
      icon: ExternalLink,
      external: true,
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
  consultation: "Consultation",
  subscription: "Subscription",
  webinars: "Webinar",
  webinar: "Webinar",
  offerings: "Sell",
  "digital-product": "Digital product",
  sell: "Sell",
  sessions: "1:1 & subscriptions",
  programs: "Group programs",
  products: "Products",
  availability: "Availability",
  requests: "Booking requests",
  timings: "Timings",
  allocate: "Allocate",
  reschedule: "Reschedule",
  collaborations: "Collaborations",
  reviews: "Reviews",
  recordings: "Recordings",
  documents: "Session documents",
  library: "My library",
  earnings: "Earnings & payouts",
  referrals: "Invite & earn",
  settings: "Settings",
  // Settings hub sections: one URL each, so one crumb each.
  profile: "Profile",
  experience: "Experience & education",
  verification: "Verification",
  booking: "Booking mode",
  "get-paid": "Get paid",
  payouts: "Payouts",
  notifications: "Notifications",
  support: "Help & support",
  evidence: "Evidence requests",
  reports: "Reports & appeals",
  feedback: "Product feedback",
  edit: "Edit",
  new: "New",
};

// These have only child pages; linking their crumb would prefetch a 404.
export const CONSULTANT_PATHLESS_SEGMENTS: ReadonlySet<string> = new Set([
  "participants",
  "sell",
  "payouts",
]);

/** An editor's first crumb: Studio's Products for a digital product, else Sell. */
export const consultantOfferingsRootLabel = (
  typeSegment: string | undefined,
): string =>
  typeSegment === "digital-product" ? CONSULTANT_PAGE_LABELS.products : "Sell";

export const CONSULTANT_OFFERING_TYPE_SEGMENTS: ReadonlySet<string> = new Set(
  SellableKindSchema.options,
);
