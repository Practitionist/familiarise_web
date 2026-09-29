import { Fraunces, Inter, Sora } from "next/font/google";

/**
 * The app's font instances.
 *
 * `next/font` generates a separately-hashed family per call site, so calling
 * `Inter()` in more than one module yields two different families (and two
 * fallback-metric faces) that render subtly differently. Every surface that
 * owns an `<html>/<body>` pair — the root layout and `global-error` — imports
 * these instances instead of declaring their own.
 *
 * ── Why Sora stopped being the only face ──────────────────────────────────────
 *
 * Sora is a geometric-grotesque DISPLAY face: a single family was doing both
 * `fontFamily.sans` and `fontFamily.display`, so every 13–15px UI string
 * rendered in a face drawn for headlines, and the `font-medium`/`font-semibold`
 * weights the app leans on hardest were never designed at those sizes.
 *
 * Inter is now the text face (it is drawn for UI copy, and is a variable font
 * so the whole weight axis ships in one file). Sora is RETAINED rather than
 * deleted, because it is wired to the marketing/landing typography and removing
 * it is a separate, larger re-skin. It is simply no longer the body face.
 *
 * Fraunces is the editorial display face for the `editorial` theme direction
 * only. It is deliberately scoped to `body[data-theme="editorial"]` in
 * globals.css, so a browser only downloads the woff2 when that theme is
 * actually active — an unused @font-face costs nothing.
 */
export const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

/** Display face for the `editorial` direction. Loaded only when selected. */
export const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
  // Axes Fraunces exposes beyond weight/opsz. `SOFT` and `WONK` are what make
  // it read as a literary face rather than a generic serif; the display swap
  // keeps the variable axis cost bounded.
  axes: ["SOFT", "WONK"],
});

/**
 * @deprecated Retained for the marketing/landing typography that still calls
 * for it. New work should use `inter` (text) — see the note above.
 */
export const sora = Sora({
  subsets: ["latin"],
  variable: "--font-sora",
  display: "swap",
});
