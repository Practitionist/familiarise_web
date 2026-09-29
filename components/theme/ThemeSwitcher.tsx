"use client";

import { useCallback, useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { applyTheme, setTheme } from "./ThemeProvider";
import {
  DEFAULT_MODE,
  DEFAULT_THEME,
  isMode,
  isTheme,
  MODE_META,
  MODE_STORAGE_KEY,
  switcherEnabled,
  THEME_META,
  THEME_STORAGE_KEY,
  type Mode,
  type Theme,
} from "./theme-config";

/**
 * The comparison toolbar.
 *
 * Its job is to let a decision get made: three directions × two modes, live on
 * the real pages, so they can be screenshotted next to each other. It is a
 * review tool, not a shipped product feature, so it is hidden unless
 * `?themes=1` is present or the app is running in development (see
 * `switcherEnabled`).
 *
 * It renders nothing at all when hidden — not a hidden element, nothing — so
 * the production DOM is identical to today's.
 */
export function ThemeSwitcher() {
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);
  const [mode, setModeState] = useState<Mode>(DEFAULT_MODE);

  useEffect(() => {
    // Gate on `mounted` rather than reading the URL during render: the search
    // string is not available to a statically-prerendered server render, and
    // branching on it during render would be a hydration mismatch.
    const enabled = switcherEnabled(
      window.location.search,
      process.env.NODE_ENV !== "production",
    );
    setVisible(enabled);
    if (!enabled) return;

    const readAxis = <T,>(key: string, guard: (v: unknown) => v is T, fallback: T) => {
      try {
        const raw = window.localStorage.getItem(key);
        return raw !== null && guard(raw) ? raw : fallback;
      } catch {
        return fallback;
      }
    };
    const initialTheme = readAxis<Theme>(THEME_STORAGE_KEY, isTheme, DEFAULT_THEME);
    const initialMode = readAxis<Mode>(MODE_STORAGE_KEY, isMode, DEFAULT_MODE);
    setThemeState(initialTheme);
    setModeState(initialMode);
    setMounted(true);
  }, []);

  /**
   * The correction pass runs AFTER mount, so the browser has already painted
   * the default theme. Without suppressing transitions that correction animates
   * as a full-page colour sweep, which looks like a bug rather than a switch.
   * 150ms is longer than the correction needs and short enough to read as
   * instant.
   */
  useEffect(() => {
    if (!mounted) return;
    const body = document.body;
    const previous = body.style.transition;
    body.style.transition = "none";
    applyTheme(theme, mode);
    const raf = requestAnimationFrame(() => {
      body.style.transition = previous;
    });
    return () => cancelAnimationFrame(raf);
  }, [mounted, theme, mode]);

  const chooseTheme = useCallback((next: Theme) => {
    setThemeState(next);
    setTheme(next, readMode());
  }, []);

  const chooseMode = useCallback((next: Mode) => {
    setModeState(next);
    setTheme(readTheme(), next);
  }, []);

  // Read the sibling axis from the DOM rather than closing over state, so the
  // two callbacks never capture a stale value of the other axis.
  const readMode = (): Mode => {
    const attr = document.body.dataset.mode;
    return attr && isMode(attr) ? attr : DEFAULT_MODE;
  };
  const readTheme = (): Theme => {
    const attr = document.body.dataset.theme;
    return attr && isTheme(attr) ? attr : DEFAULT_THEME;
  };

  if (!visible) return null;

  return (
    <div
      // Fixed to the viewport rather than themed by it: the switcher must stay
      // legible while comparing a dark direction, so it hard-codes its own
      // surfaces instead of consuming the tokens it is switching.
      className="fixed bottom-4 left-1/2 z-[9999] -translate-x-1/2 font-sans"
      data-theme-switcher=""
      // The switcher is a review affordance, not page content. Keeping it out
      // of the a11y tree in production avoids shipping a control with no
      // product meaning to a screen reader.
      aria-hidden={process.env.NODE_ENV === "production" ? undefined : false}
    >
      <div className="flex items-center gap-1 rounded-2xl border border-white/10 bg-neutral-900/95 p-1.5 shadow-2xl backdrop-blur-xl">
        {(["precision", "editorial", "gallery"] as const).map((id) => {
          const active = mounted && theme === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => chooseTheme(id)}
              title={THEME_META[id].blurb}
              aria-pressed={active}
              className={`group flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-xs font-medium transition-colors ${
                active
                  ? "bg-white text-neutral-900"
                  : "text-neutral-400 hover:bg-white/10 hover:text-white"
              }`}
            >
              <span className="flex gap-0.5" aria-hidden="true">
                {THEME_META[id].swatch.map((c) => (
                  <span
                    key={c}
                    className="h-3.5 w-1.5 rounded-[2px] ring-1 ring-black/20"
                    style={{ backgroundColor: c }}
                  />
                ))}
              </span>
              <span className="hidden sm:inline">{THEME_META[id].label}</span>
            </button>
          );
        })}

        <span className="mx-0.5 h-6 w-px bg-white/15" aria-hidden="true" />

        {(["light", "dark"] as const).map((id) => {
          const active = mounted && mode === id;
          const Icon = id === "light" ? Sun : Moon;
          return (
            <button
              key={id}
              type="button"
              onClick={() => chooseMode(id)}
              title={MODE_META[id].label}
              aria-label={`${MODE_META[id].label} mode`}
              aria-pressed={active}
              className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                active
                  ? "bg-white text-neutral-900"
                  : "text-neutral-400 hover:bg-white/10 hover:text-white"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
