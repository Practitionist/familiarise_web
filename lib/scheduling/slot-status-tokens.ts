/**
 * One colour vocabulary for slot availability.
 *
 * The same four states were painted three different ways depending on which
 * screen you were on:
 *
 *   consultant calendar   green-300 / yellow-400 / slate-400 / black
 *   buyer profile grid    emerald  / amber      / gray      / orange
 *   buyer time picker     emerald-500/10 / amber-500/10 / rose-500/10 (on dark)
 *
 * A consultee who looked at an expert's profile and then opened the picker was
 * reading two different languages for the same information. Worse, none of the
 * three surfaces carried a legend, so the vocabulary was never stated anywhere.
 *
 * These tokens are the single source. `SlotStatusLegend` renders them, so a new
 * state cannot be added without the legend gaining an entry.
 */

export type SlotStatusKey =
  | "available"
  | "partiallyBooked"
  | "fullyBooked"
  | "selected"
  | "thisEvent"
  | "rescheduling"
  | "unavailable";

export interface SlotStatusToken {
  /** Shown in the legend and in cell tooltips. */
  label: string;
  /** Cell classes on a light surface. */
  className: string;
  /** Legend swatch — a solid block, so it reads at 12px. */
  swatchClassName: string;
  /** What the state means, for the legend's title attribute. */
  hint: string;
}

export const SLOT_STATUS_TOKENS: Record<SlotStatusKey, SlotStatusToken> = {
  available: {
    label: "Available",
    className:
      "bg-emerald-100 text-emerald-900 border-emerald-300 hover:bg-emerald-200",
    swatchClassName: "bg-emerald-300",
    hint: "Free to book.",
  },
  partiallyBooked: {
    label: "Partly booked",
    className: "bg-amber-100 text-amber-900 border-amber-300",
    swatchClassName: "bg-amber-300",
    hint: "Some of this interval is taken; a full session may not fit.",
  },
  fullyBooked: {
    label: "Booked",
    className: "bg-slate-200 text-slate-600 border-slate-300",
    swatchClassName: "bg-slate-400",
    hint: "Already taken.",
  },
  selected: {
    label: "Selected",
    className: "bg-emerald-700 text-white border-emerald-800",
    swatchClassName: "bg-emerald-700",
    hint: "You have chosen this time.",
  },
  thisEvent: {
    label: "This booking",
    className: "bg-zinc-900 text-white border-zinc-900",
    swatchClassName: "bg-zinc-900",
    hint: "Belongs to the booking you are editing.",
  },
  rescheduling: {
    label: "Being moved",
    className: "bg-amber-400 text-amber-950 border-amber-500",
    swatchClassName: "bg-amber-400",
    hint: "Released by a reschedule and awaiting a new time.",
  },
  unavailable: {
    label: "Unavailable",
    className: "bg-slate-100 text-slate-400 border-slate-200",
    swatchClassName: "bg-slate-200",
    hint: "Outside the consultant's published availability.",
  },
};

/** The states worth explaining on a read-only grid. */
export const BUYER_LEGEND_KEYS: SlotStatusKey[] = [
  "available",
  "partiallyBooked",
  "fullyBooked",
  "unavailable",
];

/** Everything the consultant's allocate calendar can show. */
export const CONSULTANT_LEGEND_KEYS: SlotStatusKey[] = [
  "available",
  "selected",
  "partiallyBooked",
  "fullyBooked",
  "thisEvent",
  "rescheduling",
  "unavailable",
];
