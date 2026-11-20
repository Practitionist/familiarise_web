/**
 * One status vocabulary for every time grid: the dashboard heat map, the
 * mobile day list, the trial picker and the legend all read this table.
 *
 * Each state carries a colour AND a non-colour cue (pattern, border style or
 * icon), so no two states are told apart by hue alone, and every identifying
 * border clears 3:1 against the white card the grids sit on. Cells and legend
 * swatches derive from the same `fill`/`border`/`pattern`, so a swatch can
 * never document a paint the grid does not use.
 */

import { MAX_BOOKING_HORIZON_DAYS } from "@/lib/booking/lead-time";
import { cn } from "@/utils/tailwind";

export type SlotStatusKey =
  | "available"
  | "outsideCoHostHours"
  | "partiallyBooked"
  | "fullyBooked"
  | "selected"
  | "thisEvent"
  | "rescheduling"
  | "limitReached"
  | "tooSoon"
  | "beyondHorizon"
  | "justTaken"
  | "outsidePeriod"
  | "past"
  | "unavailable";

/** The glyph a state draws inside its cell; rendered by `SlotStatusIcon`. */
export type SlotStatusIconName =
  "lock" | "person" | "people" | "check" | "move";

/** Diagonal hatch for "partly taken". */
const HATCH_AMBER =
  "bg-[repeating-linear-gradient(45deg,theme(colors.amber.500)_0_1.5px,transparent_1.5px_6px)]";
/** Cross-hatch for "plan limit used up". */
const CROSS_HATCH_SLATE =
  "bg-[repeating-linear-gradient(45deg,theme(colors.slate.400)_0_1px,transparent_1px_6px),repeating-linear-gradient(-45deg,theme(colors.slate.400)_0_1px,transparent_1px_6px)]";
/** Wide 45° stripe for "outside this booking's period". */
const HATCH_SLATE =
  "bg-[repeating-linear-gradient(45deg,theme(colors.slate.300)_0_2px,transparent_2px_7px)]";
/** Horizontal rules for "later than bookings open". */
const RULED_SLATE =
  "bg-[repeating-linear-gradient(0deg,theme(colors.slate.400)_0_1px,transparent_1px_5px)]";
/** One diagonal rule across the cell: the strike-through of "just taken". */
const STRIKE_ROSE =
  "bg-[linear-gradient(to_top_right,transparent_calc(50%-1px),theme(colors.rose.600)_calc(50%-1px),theme(colors.rose.600)_calc(50%+1px),transparent_calc(50%+1px))]";

/** The hand-authored half of a token: one colour per state, written once. */
interface SlotStatusPaint {
  label: string;
  hint: string;
  /** Background colour. Shared by the cell and its legend swatch. */
  fill: string;
  /** Border colour. Shared likewise; the base string owns only the width. */
  border: string;
  /** Cell label colour. Swatches carry no text. */
  text: string;
  /** Cells only, and only where the cell does something when clicked. */
  hover?: string;
  /** The non-colour cue shared by cell and swatch: a texture or border style. */
  pattern?: string;
  /** A glyph drawn in every cell of the state (and in its swatch). */
  icon?: SlotStatusIconName;
  /** Extra text decoration for the cell label. */
  decoration?: string;
  /** Whether a click on the cell can change the selection. */
  interactive: boolean;
  /**
   * WCAG 1.4.11 exempts inactive, purely decorative areas. Only the flat
   * "outside availability" and "already gone" states use it.
   */
  contrastExempt?: true;
}

export interface SlotStatusToken {
  /** Shown in the legend, cell tooltips and the cell's accessible name. */
  label: string;
  /** What the state means, for the legend's title and screen readers. */
  hint: string;
  fill: string;
  border: string;
  text: string;
  pattern?: string;
  icon?: SlotStatusIconName;
  interactive: boolean;
  contrastExempt?: true;
  /** Cell classes on a light surface. */
  className: string;
  /** Legend swatch: the cell's own fill, border and pattern. */
  swatchClassName: string;
}

const SLOT_STATUS_PAINT: Record<SlotStatusKey, SlotStatusPaint> = {
  available: {
    label: "Free",
    hint: "Free to book.",
    fill: "bg-emerald-100",
    border: "border-emerald-600",
    text: "text-emerald-900",
    hover: "hover:bg-emerald-200",
    interactive: true,
  },
  outsideCoHostHours: {
    label: "Outside a co-host's hours",
    hint: "Free for the host, but a co-host's available hours don't cover this time.",
    fill: "bg-slate-100",
    border: "border-slate-500",
    text: "text-slate-700",
    icon: "people",
    interactive: false,
  },
  partiallyBooked: {
    label: "Partly booked",
    hint: "Part of this half-hour is taken — choose another time.",
    fill: "bg-amber-100",
    border: "border-amber-600",
    text: "text-amber-950",
    pattern: HATCH_AMBER,
    interactive: false,
  },
  fullyBooked: {
    label: "Booked",
    hint: "Already taken.",
    fill: "bg-slate-300",
    border: "border-slate-500",
    text: "text-slate-800",
    icon: "lock",
    interactive: false,
  },
  selected: {
    label: "Selected",
    hint: "You have chosen this time.",
    fill: "bg-emerald-700",
    border: "border-emerald-900",
    text: "text-white",
    hover: "hover:bg-emerald-800",
    icon: "check",
    interactive: true,
  },
  thisEvent: {
    label: "This booking",
    hint: "Belongs to the booking you are working on.",
    fill: "bg-indigo-200",
    border: "border-indigo-600",
    text: "text-indigo-950",
    hover: "hover:bg-indigo-300",
    icon: "person",
    interactive: true,
  },
  rescheduling: {
    label: "Being moved",
    hint: "Released by a reschedule and waiting for a new time.",
    fill: "bg-orange-100",
    border: "border-orange-700",
    text: "text-orange-950",
    pattern: "border-dashed",
    icon: "move",
    interactive: false,
  },
  limitReached: {
    label: "Limit reached",
    hint: "This plan's sessions for that week or day are already used.",
    fill: "bg-slate-100",
    border: "border-slate-500",
    text: "text-slate-700",
    pattern: CROSS_HATCH_SLATE,
    interactive: false,
  },
  tooSoon: {
    label: "Too soon",
    hint: "Too close to its start for this booking — pick a later time.",
    fill: "bg-slate-100",
    border: "border-slate-500",
    text: "text-slate-700",
    pattern: "border-2 border-dotted",
    interactive: false,
  },
  beyondHorizon: {
    label: "Too far ahead",
    hint: `Bookings open up to ${MAX_BOOKING_HORIZON_DAYS} days ahead.`,
    fill: "bg-slate-50",
    border: "border-slate-500",
    text: "text-slate-700",
    pattern: RULED_SLATE,
    interactive: false,
  },
  justTaken: {
    label: "Just taken",
    hint: "Someone booked this a moment ago.",
    fill: "bg-rose-100",
    border: "border-rose-600",
    text: "text-rose-900",
    pattern: STRIKE_ROSE,
    decoration: "line-through",
    interactive: false,
  },
  outsidePeriod: {
    label: "Outside period",
    hint: "Inside the published hours but outside this booking's dates.",
    fill: "bg-white",
    border: "border-slate-500",
    text: "text-slate-700",
    pattern: HATCH_SLATE,
    interactive: false,
  },
  past: {
    label: "Past",
    hint: "Already gone; shown so the day reads whole.",
    fill: "bg-slate-50",
    border: "border-transparent",
    text: "text-slate-600",
    pattern: "opacity-50",
    interactive: false,
    contrastExempt: true,
  },
  unavailable: {
    label: "Unavailable",
    hint: "Outside the published hours.",
    fill: "bg-transparent",
    border: "border-transparent",
    text: "text-slate-500",
    interactive: false,
    contrastExempt: true,
  },
};

export const SLOT_STATUS_KEYS = Object.keys(
  SLOT_STATUS_PAINT,
) as SlotStatusKey[];

export const SLOT_STATUS_TOKENS = Object.fromEntries(
  SLOT_STATUS_KEYS.map((key) => {
    const paint = SLOT_STATUS_PAINT[key];
    const token: SlotStatusToken = {
      label: paint.label,
      hint: paint.hint,
      fill: paint.fill,
      border: paint.border,
      text: paint.text,
      pattern: paint.pattern,
      icon: paint.icon,
      interactive: paint.interactive,
      contrastExempt: paint.contrastExempt,
      className: [
        paint.fill,
        paint.text,
        paint.border,
        paint.hover,
        paint.pattern,
        paint.decoration,
      ]
        .filter(Boolean)
        .join(" "),
      // No text colour and no hover: a swatch is a 14px block, not a control.
      swatchClassName: [paint.fill, paint.border, paint.pattern]
        .filter(Boolean)
        .join(" "),
    };
    return [key, token];
  }),
) as Record<SlotStatusKey, SlotStatusToken>;

/** The free state: a click may place a session on it. */
export function isFreeStatusKey(key: SlotStatusKey): boolean {
  return key === "available";
}

/** The cell's name for "outsideCoHostHours": the co-host's first name when exactly one is known. */
export function outsideCoHostHoursLabel(firstNames: readonly string[]): string {
  return firstNames.length === 1
    ? `Outside ${firstNames[0]}'s hours`
    : SLOT_STATUS_PAINT.outsideCoHostHours.label;
}

/**
 * An outline drawn OVER a cell's own state: the consultee's requested times
 * on the allocate grid. Not a status, so it never replaces the fill.
 */
export const REQUESTED_OUTLINE = {
  label: "Requested",
  hint: "A time the client asked for.",
  className: "ring-2 ring-inset ring-sky-700",
  swatchClassName: "border-2 border-sky-700 bg-white",
} as const;

/**
 * Everything a cell needs except its state. Width only, no border colour:
 * Tailwind resolves two same-specificity colour utilities by stylesheet
 * order, so a colour here would silently beat the token's.
 */
export const SLOT_CELL_BASE_CLASS =
  "h-7 w-full relative transition-colors duration-75 ease-in-out border rounded-sm text-[10px] leading-tight px-1 py-0 disabled:pointer-events-none";

/** The full class string for one grid cell; callers pass a state, never a colour. */
export function slotCellClassName(
  key: SlotStatusKey,
  options?: { faded?: boolean; className?: string },
): string {
  const token = SLOT_STATUS_TOKENS[key];
  return cn(
    SLOT_CELL_BASE_CLASS,
    token.className,
    token.interactive ? "cursor-pointer" : "cursor-not-allowed",
    options?.faded && "opacity-60",
    options?.className,
  );
}

/** The booleans a cell resolves through, in the precedence they apply. */
export interface SlotVisualFlags {
  isSelected: boolean;
  /** Selected, but the latest poll says someone else now holds it. */
  isJustTaken?: boolean;
  isThisEventSlot: boolean;
  isRescheduling: boolean;
  isBookedForDisplay: boolean;
  isPartiallyBooked: boolean;
  isAvailable: boolean;
  /** Published, but outside the booking's scheduling period. */
  isOutsidePeriod?: boolean;
  /** Inside the minimum notice before a session can start. */
  isTooSoon?: boolean;
  /** Later than a 1:1 booking may be placed. */
  isBeyondHorizon?: boolean;
  /** The plan's weekly or per-day limit is used up. */
  isLimitReached?: boolean;
  /** Free, but an accepted co-host has not published it. */
  isOutsideCoHostHours?: boolean;
  isInPast: boolean;
}

/**
 * Which token a cell paints from — the one place that decision is made.
 * "Just taken" outranks "Selected" so a conflicted pick is visible for the
 * render before it is dropped; gone outranks every not-bookable reason.
 */
export function resolveSlotStatusKey(flags: SlotVisualFlags): SlotStatusKey {
  if (flags.isJustTaken) return "justTaken";
  if (flags.isSelected) return "selected";
  if (flags.isThisEventSlot) return "thisEvent";
  if (flags.isRescheduling) return "rescheduling";
  if (flags.isBookedForDisplay) return "fullyBooked";
  if (flags.isPartiallyBooked) return "partiallyBooked";
  if (!flags.isAvailable) return "unavailable";
  if (flags.isInPast) return "past";
  if (flags.isOutsidePeriod) return "outsidePeriod";
  if (flags.isTooSoon) return "tooSoon";
  if (flags.isBeyondHorizon) return "beyondHorizon";
  if (flags.isLimitReached) return "limitReached";
  if (flags.isOutsideCoHostHours) return "outsideCoHostHours";
  return "available";
}

/** The states worth explaining on a read-only buyer grid. */
export const BUYER_LEGEND_KEYS: SlotStatusKey[] = [
  "available",
  "partiallyBooked",
  "fullyBooked",
  "tooSoon",
  "beyondHorizon",
];

/** Everything the dashboard grid can show, in legend order. */
export const CONSULTANT_LEGEND_KEYS: SlotStatusKey[] = [
  "available",
  "outsideCoHostHours",
  "selected",
  "justTaken",
  "partiallyBooked",
  "fullyBooked",
  "thisEvent",
  "rescheduling",
  "limitReached",
  "tooSoon",
  "beyondHorizon",
  "outsidePeriod",
  "past",
];

/**
 * The legend trimmed to the states the grid painted this render, in
 * `order`'s sequence. `null` (nothing painted yet) keeps the full set so the
 * legend does not flash empty on first load.
 */
export function legendKeysFor(
  order: readonly SlotStatusKey[],
  painted: ReadonlySet<SlotStatusKey> | null,
): SlotStatusKey[] {
  if (painted === null) return [...order];
  return order.filter((key) => painted.has(key));
}
