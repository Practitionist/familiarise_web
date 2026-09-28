import {
  CalendarCheck,
  CreditCard,
  FileText,
  Gift,
  Home,
  MessageSquare,
  Search,
  Settings,
  Video,
} from "lucide-react";

import { personalSupportLinks, type DashboardNav } from "./types";

/**
 * Learner (consultee) IA from #1527 §7.1. Settings lives in the avatar menu
 * and Help in the header menu (Cloudflare shell); Feedback folds into Support
 * requests.
 */
export function buildConsulteeNav(consulteeId: string): DashboardNav {
  return {
    basePath: `/dashboard/consultee/${consulteeId}`,
    groups: [
      {
        items: [
          { name: "Home", icon: Home, path: "home" },
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
        label: "Library",
        items: [
          { name: "Documents", icon: FileText, path: "documents" },
          { name: "Recordings", icon: Video, path: "recordings" },
        ],
      },
      {
        label: "Money",
        items: [
          { name: "Payments", icon: CreditCard, path: "payments" },
          { name: "Invite & earn", icon: Gift, path: "referrals" },
        ],
      },
    ],
    settings: { name: "Settings", icon: Settings, path: "settings" },
    support: personalSupportLinks(
      `/dashboard/consultee/${consulteeId}/support`,
    ),
    mobileTabs: ["home", "appointments", "messages", "payments"],
    pinnedCta: {
      label: "Find experts",
      href: "/explore/experts",
      icon: Search,
    },
  };
}

/** Breadcrumb labels — match the nav names so crumb and sidebar agree. */
export const CONSULTEE_PAGE_LABELS: Record<string, string> = {
  home: "Home",
  appointments: "Appointments",
  resources: "Resources",
  messages: "Messages",
  payments: "Payments",
  referrals: "Invite & earn",
  support: "Support requests",
  settings: "Settings",
  documents: "Documents",
  recordings: "Recordings",
  feedback: "Feedback",
  help: "Help",
  reschedule: "Reschedule",
  account: "Account",
  profile: "Learning profile",
  notifications: "Notifications",
};
