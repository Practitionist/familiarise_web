"use client";

import { use } from "react";
import type { User } from "@prisma/client";
import {
  Home,
  CalendarCheck,
  MessageSquare,
  CreditCard,
  Gift,
  LifeBuoy,
  Settings,
  FileText,
  Video,
  MessageSquareText,
  HelpCircle,
  type LucideIcon,
} from "lucide-react";

import type { CollapsibleSidebarGroup } from "@/components/dashboard/CollapsibleSidebar";
import { BreadcrumbOverrideProvider } from "@/components/dashboard/breadcrumb-override";
import {
  PersonalDashboardLayoutCore,
  type PersonalDashboardUser,
} from "@/components/dashboard/PersonalDashboardLayoutCore";
import { fetchConsulteeDetails, fetchUserDetails } from "@/lib/user";
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
    // Was "Activity" wrapping a single "Resources" item — a label that said
    // less than the thing under it. Now the group IS Resources, and the two
    // artifacts are the entries: "where is the recording" and "where is the
    // handout" are different errands, and one page tabbed by event type
    // answered neither directly.
    label: "Resources",
    items: [
      { name: "Documents", icon: FileText, path: "documents" },
      { name: "Recordings", icon: Video, path: "recordings" },
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
    // Now a real group rather than a lone entry: requests, feedback and help
    // were tabs on one page, and they are distinct destinations — a ticket
    // list, a form and an FAQ share no state and answer different questions.
    // Settings sits here as the fourth: it is the other thing people come
    // looking for when something is wrong.
    label: "Support",
    items: [
      { name: "Support requests", icon: LifeBuoy, path: "support" },
      { name: "Feedback", icon: MessageSquareText, path: "feedback" },
      { name: "Help", icon: HelpCircle, path: "help" },
      { name: "Settings", icon: Settings, path: "settings" },
    ],
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
  resources: "Resources",
  messages: "Messages",
  payments: "Payments",
  referrals: "Referrals",
  support: "Support",
  settings: "Settings",
  documents: "Documents",
  recordings: "Recordings",
  feedback: "Feedback",
  help: "Help",
  // Task route hanging off a record id; without this the trail ends on the
  // raw lowercase segment.
  reschedule: "Reschedule",
};

const PREFETCH_SUFFIXES = ["home"];

// Module-level so it is not a nested component definition: the shell must
// not remount the provider subtree on every layout render.
// Boundary cast: the core's structural user carries the Prisma User payload
// at runtime; UserProvider types it as Prisma User.
function wrapConsulteeShell(
  shell: React.ReactNode,
  user: PersonalDashboardUser,
) {
  return <UserProvider userDetails={user as User}>{shell}</UserProvider>;
}

interface PageProps {
  children: React.ReactNode;
  params: Promise<{ consulteeId: string }>;
}

export default function ConsulteeLayout(props: Readonly<PageProps>) {
  return (
    <BreadcrumbOverrideProvider>
      <ConsulteeLayoutInner {...props} />
    </BreadcrumbOverrideProvider>
  );
}

function ConsulteeLayoutInner({ children, params }: Readonly<PageProps>) {
  const { consulteeId } = use(params);
  const basePath = `/dashboard/consultee/${consulteeId}`;

  return (
    <PersonalDashboardLayoutCore
      routeParam={consulteeId}
      basePath={basePath}
      title="My Dashboard"
      chipRole="Client"
      identityFallbackName="My Dashboard"
      navGroups={NAV_GROUPS}
      mobileTabs={MOBILE_TABS}
      pageLabels={PAGE_LABELS}
      fetchUser={(userId) => fetchUserDetails(userId)}
      profileQueryKey={["consultee-profile", consulteeId]}
      fetchProfile={() => fetchConsulteeDetails(consulteeId)}
      profileGatesOnUser={false}
      hasAccess={(user) =>
        !!user &&
        (user.role === "ADMIN" ||
          user.role === "STAFF" ||
          user.consulteeProfileId === consulteeId)
      }
      resolveRedirectTarget={(user) =>
        user.consulteeProfileId &&
        user.consulteeProfileId !== consulteeId
          ? `/dashboard/consultee/${user.consulteeProfileId}/home`
          : "/dashboard"
      }
      prefetchSuffixes={PREFETCH_SUFFIXES}
      requireUserDetails
      includeUserError
      wrapShell={wrapConsulteeShell}
    >
      {children}
    </PersonalDashboardLayoutCore>
  );
}
