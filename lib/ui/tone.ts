/**
 * The six status tones every dashboard badge, dot and KPI value draws from
 * (#1527 §15). Moved here from `lib/dashboard/money-state.ts`, which keeps a
 * re-export so its importers do not change. Pure and dependency-free so both
 * server and client components can import it.
 *
 * Which tone a state gets:
 * - success: the thing is done (paid, completed, verified).
 * - info: the thing is in flight and nobody needs to act yet.
 * - caution: it is waiting on someone else.
 * - warning: it is waiting on you.
 * - critical: it failed, was declined or is disputed.
 * - neutral: it is terminal or inert (cancelled, refunded, free).
 *
 * Status colour comes only from here; everything else stays monochrome.
 */

export type Tone =
  | "neutral"
  | "info"
  | "success"
  | "caution"
  | "warning"
  | "critical";

export interface ToneStyle {
  /** Pill surface: background, text and border. */
  className: string;
  /** The leading dot. */
  dotClassName: string;
}

/** Existing palette only (lib/labels/session-labels.ts conventions). */
export const TONE_CLASS: Record<Tone, ToneStyle> = {
  neutral: {
    className: "bg-zinc-100 text-zinc-600 border-zinc-200",
    dotClassName: "bg-zinc-400",
  },
  info: {
    className: "bg-blue-100 text-blue-900 border-blue-200",
    dotClassName: "bg-blue-500",
  },
  success: {
    className: "bg-green-100 text-green-900 border-green-200",
    dotClassName: "bg-green-500",
  },
  caution: {
    className: "bg-amber-100 text-amber-900 border-amber-200",
    dotClassName: "bg-amber-500",
  },
  warning: {
    className: "bg-orange-100 text-orange-900 border-orange-200",
    dotClassName: "bg-orange-500",
  },
  critical: {
    className: "bg-red-100 text-red-900 border-red-200",
    dotClassName: "bg-red-500",
  },
};

/** Text-only colour for a KPI value; neutral keeps the foreground colour. */
const TONE_TEXT_CLASS: Record<Tone, string> = {
  neutral: "text-foreground",
  info: "text-blue-700",
  success: "text-green-700",
  caution: "text-amber-700",
  warning: "text-orange-700",
  critical: "text-red-700",
};

export function toneClass(tone: Tone): ToneStyle {
  return TONE_CLASS[tone];
}

export function toneTextClass(tone: Tone): string {
  return TONE_TEXT_CLASS[tone];
}

/**
 * "AWAITING_PAYMENT" → "Awaiting Payment". The last-resort label for an enum
 * no label map covers yet; a map entry always reads better (#1527 raw-enum
 * sweep).
 */
export function humanizeEnum(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
