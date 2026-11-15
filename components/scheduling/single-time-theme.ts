/** The single-time picker's two themes: dark for the public booking dialogs, light for dashboards. */
export type PickerTheme = "light" | "dark";

export interface PickerTokens {
  /** Each pane's card; the picker sets its padding by the width it is given. */
  pane: string;
  heading: string;
  muted: string;
  /** Icon buttons in the month header. */
  navButton: string;
  weekday: string;
  /** A day cell, before its state classes. */
  day: string;
  daySelected: string;
  dayFree: string;
  dayPlain: string;
  dayDisabled: string;
  /** A time button, before its state classes. */
  time: string;
  timeSelected: string;
  /** A time that cannot be picked: booked, held or just taken. */
  timeUnavailable: string;
  /** A host's time outside published hours. */
  timeOutside: string;
  focus: string;
  skeleton: string;
  notice: string;
  /** A taken time listed under "Show taken times". */
  takenRow: string;
  /** A refusal shown inline, such as the cap on waiting. */
  error: string;
}

const SHARED_FOCUS = "focus-visible:outline-none focus-visible:ring-2";

export const PICKER_TOKENS: Record<PickerTheme, PickerTokens> = {
  dark: {
    pane: "rounded-xl border border-zinc-700/50 bg-zinc-800/60",
    heading: "text-white",
    muted: "text-zinc-400",
    navButton: "text-zinc-300 hover:bg-zinc-700/60 hover:text-white",
    weekday: "text-zinc-400",
    day: "text-zinc-200",
    daySelected: "bg-white font-semibold text-zinc-900 shadow-md",
    dayFree:
      "font-semibold text-white ring-1 ring-white/40 hover:bg-zinc-700/60",
    dayPlain: "text-zinc-400 hover:bg-zinc-700/60",
    dayDisabled: "cursor-not-allowed text-zinc-600 opacity-50",
    time: "border-white/[0.12] text-zinc-100 hover:bg-white/[0.06]",
    timeSelected: "border-white bg-white text-zinc-900 shadow-md",
    timeUnavailable:
      "cursor-not-allowed border-dashed border-white/[0.12] text-zinc-500",
    timeOutside:
      "border-dashed border-white/[0.24] text-zinc-300 hover:bg-white/[0.06]",
    focus: `${SHARED_FOCUS} focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900`,
    skeleton: "bg-zinc-700/60",
    notice: "border-zinc-700 bg-zinc-900/60 text-zinc-200",
    takenRow: "border-dashed border-white/[0.12] text-zinc-400",
    error: "text-red-300",
  },
  light: {
    pane: "rounded-xl border border-border bg-muted/40",
    heading: "text-foreground",
    muted: "text-muted-foreground",
    navButton: "text-muted-foreground hover:bg-muted hover:text-foreground",
    weekday: "text-muted-foreground",
    day: "text-foreground",
    daySelected: "bg-primary font-semibold text-primary-foreground shadow-md",
    dayFree:
      "font-semibold text-foreground ring-1 ring-primary/50 hover:bg-muted",
    dayPlain: "text-muted-foreground hover:bg-muted",
    dayDisabled: "cursor-not-allowed text-muted-foreground opacity-40",
    time: "border-border bg-background text-foreground hover:bg-muted",
    timeSelected: "border-primary bg-primary text-primary-foreground shadow-md",
    timeUnavailable:
      "cursor-not-allowed border-dashed border-border bg-muted text-muted-foreground",
    timeOutside:
      "border-dashed border-border bg-background text-foreground hover:bg-muted",
    focus: `${SHARED_FOCUS} focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background`,
    skeleton: "bg-muted",
    notice: "border-border bg-background text-foreground",
    takenRow: "border-dashed border-border bg-muted text-muted-foreground",
    error: "text-destructive",
  },
};
