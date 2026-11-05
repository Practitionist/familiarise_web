import {
  CalendarCheck,
  CreditCard,
  Gift,
  Home,
  Library,
  LifeBuoy,
  MessageSquare,
  Search,
  Settings,
} from "lucide-react";

import { personalSupportLinks, type DashboardNav } from "./types";

/** Learners find account operations alongside their work and billing. */
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
          { name: "Library", icon: Library, path: "library" },
        ],
      },
      {
        label: "Money",
        items: [
          { name: "Billing", icon: CreditCard, path: "payments" },
          { name: "Invite & earn", icon: Gift, path: "referrals" },
        ],
      },
      {
        label: "Operations",
        items: [
          { name: "Help & support", icon: LifeBuoy, path: "support" },
          { name: "Settings", icon: Settings, path: "settings" },
        ],
      },
    ],
    support: personalSupportLinks(
      `/dashboard/consultee/${consulteeId}/support`,
    ),
    // Billing lives in the Menu sheet; Home carries the "Needs you" card.
    mobileTabs: ["home", "appointments", "library", "messages"],
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
  payments: "Billing",
  referrals: "Invite & earn",
  support: "Help & support",
  evidence: "Evidence requests",
  reports: "Reports & appeals",
  settings: "Settings",
  library: "Library",
  documents: "Session documents",
  recordings: "Session recordings",
  feedback: "Product feedback",
  help: "Help",
  reschedule: "Reschedule",
  account: "Account",
  profile: "Learning profile",
  notifications: "Notifications",
};
