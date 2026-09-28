import { requireNotOnboarded } from "@/lib/auth-guard";

/**
 * Pre-paint script that activates the `.dark` token scope for this route.
 *
 * It has to run HERE, in the server-rendered HTML, rather than from a client
 * effect in the shell. A `useLayoutEffect` in the shell would still run after
 * the browser had painted the server-rendered markup, so the page would flash
 * light-then-dark on every load; this runs during HTML parsing, before first
 * paint, so there is no flash.
 *
 * Why `<html>` and not the shell's own div: Radix portals. Select, Dialog,
 * Popover, DropdownMenu and Tooltip all mount into `document.body`, which is
 * OUTSIDE the shell subtree — so with the class on the shell, every dropdown
 * and modal resolved `--popover` / `--background` against `:root` and rendered
 * as a white panel over a near-black card. Scoping at the root is the standard
 * fix and the only one that covers portal content.
 *
 * Scope: `/form/` is in `NO_CHROME_PREFIXES` (lib/navigation/public-chrome.ts),
 * so the Navbar, Footer and HeaderSpacer do not render here — the shell is the
 * whole page, and root-level is the right scope for it. `OnboardingShell`
 * removes the class on unmount, so a client-side navigation into the dashboard
 * does not inherit a dark `<html>`.
 */
const APPLY_DARK = "document.documentElement.classList.add('dark')";

export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireNotOnboarded();
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: APPLY_DARK }} />
      {children}
    </>
  );
}
