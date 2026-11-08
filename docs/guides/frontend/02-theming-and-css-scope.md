# Theming and CSS Scope

How dark styling works in this app, and the one pattern we explicitly rejected.

---

## The shape of it

`app/globals.css` holds the dark token set, reachable two ways:

```css
.dark,
body:has(.onboarding-shell) {
  /* ~370 dark: utilities resolve against these tokens */
}
```

1. **`.dark` on `<html>`** — the normal route, and what a real user-toggleable
   theme would use. Dormant today: nothing in the app sets the class, so the
   block and its utilities are authored but inactive.
2. **`body:has(.onboarding-shell)`** — onboarding is a **dark-only route**, not
   a user-toggleable theme, so it must not need theme machinery at all.

Because the tokens land on `body`, a portal mounted there inherits them
directly — no per-component threading.

---

## Never mutate `documentElement` from a route

This is the invariant, and it is worth stating as a prohibition because the
obvious approach is wrong.

Onboarding **used to** try to theme itself with an inline `<script>` in the route
layout that added `.dark` to `document.documentElement`, plus a mount effect to
restore the class after the `fullBleed` org step unmounted the shell. It was
wrong three ways:

1. **It only works before first paint, but a nested layout renders the script in
   BODY position, not `<head>`.** Every account of this pattern in BODY
   position reports the flash it was supposed to prevent.
2. **Mutating `<html>` before hydration is a React mismatch.** The documented
   remedy is `suppressHydrationWarning` on `<html>` — which
   `__tests__/dashboards/shell-overflow-contract.test.ts:156` deliberately
   forbids. The old approach existed to create a violation the test bans.
3. **It needs a restore effect**, which is state that can be lost by an unmount.

The CSS-only version has no pre-paint window and no hydration to mismatch, it
re-applies itself on every render, and the `fullBleed` unmount cannot lose it.

**How to apply:** to scope a theme to a subtree, use a `:has()` selector on a
stable ancestor. Do not write a `<script>` that sets `documentElement.className`.
Do not add `suppressHydrationWarning` to `<html>`.

---

## `:has()` degrades gracefully here, on purpose

`:has()` is Baseline widely-available. The repo already depends on it for
flush-bottom chrome. In this specific case a browser without it **renders
onboarding light** — the old behaviour, not a broken one. That asymmetry is why
the pattern is acceptable: the failure mode is the previous experience.

Pick this deliberately. A `:has()` feature whose fallback is a _broken_ layout
needs a polyfill or a different approach.

---

## Tokens, not raw values

Components consume the token scale, not literal colours. A raw hex in a
component is a review comment. When onboarding needed an accent that the
existing scale did not cover, the right move was to extend the scale — not to
inline a value in the one component that used it.

## The contract-test sharp edge

`app/globals.css` is scanned as **text** by
`__tests__/dashboards/shell-overflow-contract.test.ts`, which locates rules with
a plain `indexOf`.

A comment that names a scanned selector **earlier in the file** wins that
`indexOf`, so the extraction starts in the wrong place: the assertion then
compares the comment's fragment plus the block that follows it, not the real
rule's selector and body. This caused a real CI failure on #1864 — a prose
comment in the dark-scope block named the flush-bottom selector, and the test
failed with a diff quoting my own comment back at me.

**Do not spell out a scanned selector inside a comment near it.** Describe it in
prose instead. A failure diff that quotes your comment is the tell.

## Brand mark

The brand is a text wordmark, not an image. `BrandWordmark` in
`components/brand/BrandWordmark.tsx` renders the product name in the display
font (`font-display`, which is Sora) at `text-primary`, so it follows the theme
tokens. It is set at weight 600, one step lighter than the bold headings so it
does not read as one, with tracking of -0.01em at 20px and below and -0.02em
from 24px up. It has four sizes (`sm`, `md`, `lg`, and the responsive `nav` used by the
header) and two tones: `default` reads the tokens, and `inverse` is fixed white
for the dark hero, the footer and the mobile drawer. `BrandMark` in the same file
is the decorative square letter mark for badge-sized slots, such as the "on
Familiarise" line on program cards and reviews. Each call site keeps the box
size the old image had, so swapping the mark does not move the layout.

The name and its hex colour live in `lib/brand.ts`. Surfaces that cannot read
CSS variables use those constants directly: the shared email header
`emails/components/EmailLogo.tsx` (inline styles, system font stack, no image
request) and the bare HTML page from `app/api/newsletter/unsubscribe/route.ts`.
The favicon is `app/icon.svg`, a white "F" on the brand colour, which Next.js
serves through its file convention. `app/favicon.ico` (16, 32 and 48 px) and the
full-bleed 180 px `app/apple-icon.png` are rendered from that SVG, so browsers
that request `/favicon.ico` directly and iOS home screens get the same mark. A
rebrand therefore changes `lib/brand.ts`, redraws `app/icon.svg` and re-renders
the two raster icons from it. Do not reintroduce a logo image for the wordmark,
because a wordmark in text needs no asset, works with images blocked in email,
and cannot drift from the name.
