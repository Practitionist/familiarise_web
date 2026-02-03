/**
 * Shared status configuration for consultee dashboard components.
 *
 * Centralizes status badge styling used across EventCard, HomeTab
 * (UpcomingSessionCard), and HomeTab (MonthlyEventItem).
 */

export interface StatusStyle {
  bg: string;
  text: string;
  dot: string;
  label?: string;
}

export interface StatusStyleDark {
  bg: string;
  text: string;
}

export const STATUS_CONFIG: Record<string, StatusStyle> = {
  APPROVED: { bg: "bg-teal-50", text: "text-teal-600", dot: "bg-teal-500" },
  PENDING: {
    bg: "bg-orange-50",
    text: "text-orange-600",
    dot: "bg-orange-500",
  },
  APPROVED_PENDING_PAYMENT: {
    bg: "bg-amber-50",
    text: "text-amber-600",
    dot: "bg-amber-500",
    label: "PAYMENT REQUIRED",
  },
  SCHEDULED: {
    bg: "bg-indigo-50",
    text: "text-indigo-600",
    dot: "bg-indigo-500",
  },
  IN_PROGRESS: { bg: "bg-cyan-50", text: "text-cyan-600", dot: "bg-cyan-500" },
  COMPLETED: {
    bg: "bg-slate-100",
    text: "text-slate-500",
    dot: "bg-slate-400",
  },
  CANCELLED: {
    bg: "bg-stone-100",
    text: "text-stone-400",
    dot: "bg-stone-400",
  },
  REJECTED: { bg: "bg-red-50", text: "text-red-600", dot: "bg-red-500" },
  EXPIRED: { bg: "bg-stone-100", text: "text-stone-500", dot: "bg-stone-400" },
};

/** Dark variant for dark-background cards (e.g. UpcomingSessionCard) */
export const STATUS_CONFIG_DARK: Record<string, StatusStyleDark> = {
  APPROVED: { bg: "bg-teal-500/15", text: "text-teal-400" },
  PENDING: { bg: "bg-orange-500/15", text: "text-orange-400" },
  SCHEDULED: { bg: "bg-indigo-500/15", text: "text-indigo-400" },
  IN_PROGRESS: { bg: "bg-cyan-500/15", text: "text-cyan-400" },
  COMPLETED: { bg: "bg-slate-500/15", text: "text-slate-400" },
  CANCELLED: { bg: "bg-stone-500/15", text: "text-stone-400" },
  REJECTED: { bg: "bg-red-500/15", text: "text-red-400" },
  EXPIRED: { bg: "bg-stone-500/15", text: "text-stone-400" },
};

export function getStatusStyle(
  status: string,
  variant: "light" | "dark" = "light",
) {
  if (variant === "dark") {
    return STATUS_CONFIG_DARK[status] ?? STATUS_CONFIG_DARK.PENDING;
  }
  return STATUS_CONFIG[status] ?? STATUS_CONFIG.PENDING;
}
