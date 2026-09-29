"use client";

import { useEffect } from "react";
import {
  DEFAULT_MODE,
  DEFAULT_THEME,
  isMode,
  isTheme,
  MODE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  type Mode,
  type Theme,
} from "./theme-config";

/**
 * Applies the stored theme/mode to `<body>`.
 *
 * Design constraints, all of them load-bearing:
 *
 *  1. **Renders `null`.** It contributes no server-rendered markup, so the
 *     first client render matches the server byte-for-byte and there is nothing
 *     to mismatch. The attributes appear in an effect, after hydration.
 *
 *  2. **Never touches `document.documentElement`.** `docs/guides/frontend/
 *     theming-and-css-scope.md` records the failed attempt at doing so, and
 *     `__tests__/dashboards/shell-overflow-contract.test.ts` forbids the
 *     `suppressHydrationWarning` on `<html>` that would paper over it.
 *
 *  3. **`<body>`, not `<html>`, is the theming root.** Every Radix overlay in
 *     this app portals to `document.body`, so dropdowns, selects, dialogs and
 *     tooltips resolve the right tokens with no per-component threading. This is
 *     the same mechanism the onboarding dark scope relies on.
 *
 *  4. **No `next-themes`.** It requires exactly the `suppressHydrationWarning`
 *     this repo's contract test bans.
 *
 * The cost of (1)+(3) is that a cold load on a non-default theme paints the
 * default first, then corrects. That is a deliberate trade: the alternative is
 * a pre-paint script on the document element, which the house rules prohibit.
 * `ThemeSwitcher` suppresses transitions for the duration of the correction so
 * the swap is not visible as a colour animation.
 */
export function ThemeProvider() {
  useEffect(() => {
    const read = <T,>(key: string, guard: (v: unknown) => v is T, fallback: T): T => {
      try {
        const raw = window.localStorage.getItem(key);
        return raw !== null && guard(raw) ? raw : fallback;
      } catch {
        // Private-mode Safari and locked-down embeds throw on localStorage
        // access. The default axis is a perfectly good answer here.
        return fallback;
      }
    };

    const theme = read<Theme>(THEME_STORAGE_KEY, isTheme, DEFAULT_THEME);
    const mode = read<Mode>(MODE_STORAGE_KEY, isMode, DEFAULT_MODE);
    applyTheme(theme, mode);

    // Keep multiple tabs consistent with each other.
    const onStorage = (e: StorageEvent) => {
      const nextTheme = e.key === THEME_STORAGE_KEY ? e.newValue : null;
      const nextMode = e.key === MODE_STORAGE_KEY ? e.newValue : null;
      applyTheme(
        nextTheme !== null && isTheme(nextTheme) ? nextTheme : theme,
        nextMode !== null && isMode(nextMode) ? nextMode : mode,
      );
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
    // Intentionally mount-only. Re-running on theme change would fight
    // ThemeSwitcher, which owns applying its own transitions.
  }, []);

  return null;
}

/** Writes the two attributes onto `<body>`. Idempotent. */
export function applyTheme(theme: Theme, mode: Mode) {
  const body = document.body;
  if (!body) return;
  body.dataset.theme = theme;
  body.dataset.mode = mode;
  // Keeps native UI (scrollbars, form controls, the canvas behind a dialog)
  // in the right scheme. `color-scheme` is not something a token can express.
  body.style.colorScheme = mode;
}

/** Persists and applies in one step. Used by the switcher. */
export function setTheme(theme: Theme, mode: Mode) {
  applyTheme(theme, mode);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // See read() — a failed write only costs persistence, not the switch.
  }
}
