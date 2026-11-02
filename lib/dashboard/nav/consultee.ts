import {
  CalendarCheck,
  CreditCard,
  FileDown,
  FileText,
  Gift,
  Home,
  LifeBuoy,
  MessageSquare,
  Search,
  Settings,
  Video,
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
        ],
      },
      {
        label: "Library",
        items: [
          { name: "Session documents", icon: FileText, path: "documents" },
          { name: "Session recordings", icon: Video, path: "recordings" },
          { name: "Digital products", icon: FileDown, path: "products" },
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
  payments: "Billing",
  referrals: "Invite & earn",
  support: "Help & support",
  evidence: "Evidence requests",
  reports: "Reports & appeals",
  settings: "Settings",
  documents: "Session documents",
  recordings: "Session recordings",
  products: "Digital products",
  feedback: "Product feedback",
  help: "Help",
  reschedule: "Reschedule",
  account: "Account",
  profile: "Learning profile",
  notifications: "Notifications",
};
