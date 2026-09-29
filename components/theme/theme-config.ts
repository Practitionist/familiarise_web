/**
 * The theme axes the app exposes.
 *
 * Two independent axes, so every theme renders correctly in both modes and a
 * mode change never silently resets the theme:
 *
 *   `theme` — the DIRECTION (the visual language: palette, radius, elevation,
 *             type stack). Three of them exist so they can be compared
 *             side-by-side on the real pages; see docs/design/explore-refresh.md.
 *   `mode`  — light or dark.
 *
 * Values are written to `data-theme` / `data-mode` on `<body>`, never on
 * `documentElement`, and never from a pre-paint script. That is deliberate and
 * constrained: `__tests__/dashboards/shell-overflow-contract.test.ts` forbids
 * `suppressHydrationWarning` in the root layout (which is what `next-themes`
 * needs), and `docs/guides/frontend/02-theming-and-css-scope.md:52` forbids
 * mutating the document element from a route. Keying off `body` also means
 * Radix portals — Select, Dialog, Popover, Tooltip, DropdownMenu — which mount
 * to `document.body` inherit the theme for free, which is the same reason the
 * onboarding dark scope is keyed off `body:has(...)`.
 */

export const THEMES = ["precision", "editorial", "gallery"] as const;
export type Theme = (typeof THEMES)[number];

export const MODES = ["light", "dark"] as const;
export type Mode = (typeof MODES)[number];

export const DEFAULT_THEME: Theme = "precision";
export const DEFAULT_MODE: Mode = "light";

/** `gallery` is a dark-first direction: it reads best in dark, but is a
 *  complete light theme too, so it is not locked to one mode. */
export const THEME_META: Record<
  Theme,
  { label: string; blurb: string; swatch: string[] }
> = {
  precision: {
    label: "Neutral",
    blurb:
      "Black and white, as the site is today — but with a real surface ladder, a real radius scale and disciplined type. The default: no colour added.",
    swatch: ["#FAFAFC", "#FFFFFF", "#18181B", "#E4E4E7"],
  },
  editorial: {
    label: "Editorial",
    blurb:
      "Warm parchment, a real display serif, and a terracotta accent. Hairline rules instead of shadows — reads like a publication, not a dashboard.",
    swatch: ["#FBF9F4", "#FFFDF8", "#A8552F", "#E4DACB"],
  },
  gallery: {
    label: "Gallery",
    blurb:
      "Dark-first with a violet accent. Media is the only bright thing; depth comes from borders and an inset top highlight rather than drop shadows.",
    swatch: ["#0C0C0F", "#16161A", "#8B7CFF", "#2A2A31"],
  },
};

export const MODE_META: Record<Mode, { label: string; icon: string }> = {
  light: { label: "Light", icon: "sun" },
  dark: { label: "Dark", icon: "moon" },
};

export const isTheme = (v: unknown): v is Theme =>
  typeof v === "string" && (THEMES as readonly string[]).includes(v);

export const isMode = (v: unknown): v is Mode =>
  typeof v === "string" && (MODES as readonly string[]).includes(v);

export const THEME_STORAGE_KEY = "fml:theme";
export const MODE_STORAGE_KEY = "fml:mode";

/**
 * The switcher is dev-gated rather than always-on: it is a comparison tool for
 * choosing a direction, not a product feature. It shows when
 *
 *   - the URL carries `?themes=1` (so it is reachable on a deploy preview, and
 *     shareable — hand someone the link and they see the same direction), or
 *   - `NODE_ENV !== "production"` (local `next dev`).
 */
export function switcherEnabled(search: string, isDev: boolean): boolean {
  if (isDev) return true;
  try {
    return new URLSearchParams(search).get("themes") === "1";
  } catch {
    return false;
  }
}
