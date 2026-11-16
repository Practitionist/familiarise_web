import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftRight,
  BadgeCheck,
  Banknote,
  BarChart3,
  Building2,
  CalendarCheck,
  Coins,
  CreditCard,
  FileWarning,
  Gauge,
  Gift,
  Home,
  Inbox,
  Landmark,
  ListChecks,
  Megaphone,
  Play,
  Receipt,
  RefreshCw,
  RotateCcw,
  Scale,
  Settings,
  ScrollText,
  ShieldAlert,
  Shield,
  Siren,
  Star,
  UserPlus,
  Users,
  Video,
  Wrench,
  Target,
} from "lucide-react";
import type { BackofficeSurface } from "@/lib/auth/backoffice-permissions";
import {
  can,
  type BackofficeCapability,
  type BackofficeTree,
} from "@/lib/backoffice/capability";
import type { NavGroup, NavItem } from "@/lib/dashboard/nav/types";
import {
  AUDIT_TAB,
  MONEY_TABS,
  type MoneyTab,
  type MoneyTabKey,
} from "@/lib/backoffice/money-tabs";

/**
 * The one nav definition behind both back-office trees.
 *
 * `/dashboard/admin` and `/dashboard/staff` are one route tree
 * (`(backoffice)/[tree]`); the tree picks the audience and the viewer's role
 * caps it (lib/backoffice/capability.ts). Every item is filtered through
 * `can(cap, surface)`, so an admin opening the staff tree sees exactly the
 * staff console.
 *
 * Metrics is the one Insights page in both trees: support-queue health plus
 * the platform's people, session and money totals.
 *
 * The sidebar is COSMETIC. Page guards and route handlers re-check the same
 * matrix keys; hiding an item only keeps the nav honest.
 */

/** Queue counts from `/api/backoffice/nav-counts`, keyed into the shell's badges. */
export type BackofficeBadgeKey =
  | "support"
  | "moderation"
  | "verification"
  | "refunds"
  | "disputes"
  | "payouts"
  | "compliance";

type NavItemSpec = NavItem & {
  surface: BackofficeSurface;
  /** Structural condition (feature flags), ANDed with the matrix. */
  show?: boolean;
  /** Restrict this item to one tree when both can't host it. */
  only?: BackofficeTree;
  badgeKey?: BackofficeBadgeKey;
};

type NavGroupSpec = {
  label?: string;
  items: NavItemSpec[];
};

export interface BackofficeNavOptions {
  /** #863 — ENABLE_TDS_ADMIN_VIEW. Hides the item when the page would 404. */
  showTds?: boolean;
}

const MONEY_ICONS: Record<MoneyTabKey, LucideIcon> = {
  payments: CreditCard,
  refunds: RotateCcw,
  disputes: Scale,
  payouts: Banknote,
  "org-payouts": Landmark,
  earnings: Coins,
  reconcile: ArrowLeftRight,
  approvals: ListChecks,
  incidents: Siren,
  "support-spend": Gauge,
  audit: ScrollText,
};

const MONEY_BADGES: Partial<Record<MoneyTabKey, BackofficeBadgeKey>> = {
  refunds: "refunds",
  disputes: "disputes",
  payouts: "payouts",
};

/** Each money section is its own item at its existing `/money/<key>` URL. */
const moneyItem = (t: MoneyTab): NavItemSpec => ({
  name: t.label,
  icon: MONEY_ICONS[t.key],
  path: `money/${t.key}`,
  surface: t.surface,
  badgeKey: MONEY_BADGES[t.key],
});

function groupSpecs({ showTds = false }: BackofficeNavOptions): NavGroupSpec[] {
  return [
    {
      items: [
        // Q12 — admin's "Needs attention"; staff land on the Support inbox.
        // Reaching the tree is the grant, so `users.read` stands in.
        {
          name: "Home",
          icon: Home,
          path: "home",
          surface: "users.read",
          only: "admin",
        },
      ],
    },
    {
      label: "Support",
      items: [
        {
          // #1527 — tickets and conversations are one inbox of cases.
          name: "Support inbox",
          icon: Inbox,
          path: "support",
          surface: "tickets.manage",
          badgeKey: "support",
        },
        {
          name: "Feedback",
          icon: Star,
          path: "feedback",
          surface: "feedback.manage",
        },
        {
          name: "Moderation",
          icon: Shield,
          path: "moderation",
          surface: "moderation.manage",
          badgeKey: "moderation",
        },
      ],
    },
    {
      label: "Operations",
      items: [
        {
          name: "Settings",
          icon: Settings,
          path: "settings",
          surface: "users.read",
        },
        {
          name: "Appointments",
          icon: CalendarCheck,
          path: "appointments",
          surface: "appointments.manage",
        },
        { name: "Users", icon: Users, path: "users", surface: "users.read" },
        // #1927 — the operator roster and the invitation door. It exists as a
        // nav item rather than a tab inside `users` because the two answer
        // different questions: `users` is "everybody on the platform", this is
        // "everybody who can reach the console". Gated on `team.read` (an
        // operator surface) rather than `users.moderate`, so staff can see the
        // roster; the ACTIONS inside are admin-only and the client hides them.
        { name: "Team", icon: UserPlus, path: "team", surface: "team.read" },
        // #1527 — one queue for experts and organizations; the document
        // review log is its Documents tab.
        {
          name: "Verification",
          icon: BadgeCheck,
          path: "verification",
          surface: "users.verify",
          badgeKey: "verification",
        },
      ],
    },
    {
      label: "Money",
      items: [
        ...MONEY_TABS.map(moneyItem),
        {
          name: "Invoices",
          icon: Receipt,
          path: "invoices",
          surface: "invoices.read",
        },
        {
          name: "Subscriptions",
          icon: RefreshCw,
          path: "subscriptions",
          surface: "subscriptions.read",
        },
        {
          name: "Referral credits",
          icon: Gift,
          path: "referral-credits",
          surface: "referrals.read",
        },
        {
          name: "TDS",
          icon: Landmark,
          path: "tds",
          surface: "tds.read",
          show: showTds,
        },
      ],
    },
    {
      label: "Growth & comms",
      items: [
        {
          name: "Leads",
          icon: Target,
          path: "leads",
          surface: "leads.manage",
        },
        {
          name: "Announcements",
          icon: Megaphone,
          path: "announcements",
          surface: "announcements.manage",
        },
        {
          name: "Newsletter",
          icon: ListChecks,
          path: "newsletter",
          surface: "newsletter.manage",
        },
      ],
    },
    {
      label: "Platform",
      items: [
        {
          name: "Organizations",
          icon: Building2,
          path: "organizations",
          surface: "organizations.manage",
        },
        {
          // #1527 Q5 — erasure requests, data breaches, failed emails.
          name: "Compliance",
          icon: FileWarning,
          path: "compliance",
          surface: "compliance.manage",
          badgeKey: "compliance",
        },
        {
          name: "Stuck work",
          icon: ShieldAlert,
          path: "stuck-work",
          surface: "systemJobs.manage",
        },
        {
          name: "System jobs",
          icon: Play,
          path: "system-jobs",
          surface: "systemJobs.manage",
        },
        {
          name: "Maintenance",
          icon: Wrench,
          path: "maintenance",
          surface: "maintenance.manage",
        },
        {
          name: "Video quality",
          icon: Video,
          path: "video-config",
          surface: "videoConfig.manage",
        },
      ],
    },
    {
      label: "Insights",
      items: [
        {
          name: "Metrics",
          icon: BarChart3,
          path: "metrics",
          surface: "analytics.read",
        },
      ],
    },
    // The audit log covers every console door, not only money, so it closes
    // the sidebar on its own. Admins read every row, staff their own.
    { items: [moneyItem(AUDIT_TAB)] },
  ];
}

export function buildBackofficeNav(
  cap: Pick<BackofficeCapability, "tree" | "role" | "audience">,
  options: BackofficeNavOptions = {},
): NavGroup[] {
  return groupSpecs(options)
    .map((g) => ({
      label: g.label,
      items: g.items
        .filter(
          (it) =>
            it.show !== false &&
            (!it.only || it.only === cap.tree) &&
            can(cap, it.surface),
        )
        .map(({ surface: _s, show: _show, only: _only, ...rest }) => rest),
    }))
    .filter((g) => g.items.length > 0);
}
