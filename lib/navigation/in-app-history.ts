/**
 * Tracks the in-app pathname trail for the current tab so "Back" buttons can
 * tell whether `router.back()` will stay inside the app.
 *
 * Why not `document.referrer`: Next.js client-side navigations never update
 * it, so after a soft navigation the referrer still points at whatever page
 * (possibly external, possibly empty) originally loaded the tab. A
 * sessionStorage-backed stack survives reloads within the tab and is scoped
 * per tab, matching the browser's own history scope.
 */

const STORAGE_KEY = "familiarise:in-app-history";
const MAX_ENTRIES = 50;

let memoryStack: string[] = [];

function readStack(): string[] {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return memoryStack;
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((entry) => typeof entry === "string")
    ) {
      return parsed;
    }
    return memoryStack;
  } catch {
    return memoryStack;
  }
}

function writeStack(stack: string[]): void {
  memoryStack = stack;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stack));
  } catch {
    // Storage unavailable (private mode / quota) — the in-memory copy suffices.
  }
}

/**
 * Pure transition: returns the next stack after visiting `pathname`.
 * - Revisiting the previous entry is treated as a back navigation (pop).
 * - Visiting a different path than the top pushes it.
 * - Re-rendering the same path is a no-op.
 */
export function nextHistoryStack(
  stack: readonly string[],
  pathname: string,
): string[] {
  const top = stack.at(-1);
  if (top === pathname) return [...stack];
  if (stack.length >= 2 && stack.at(-2) === pathname) {
    return stack.slice(0, -1);
  }
  const next = [...stack, pathname];
  return next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next;
}

let documentInitialized = false;

/**
 * A fresh document load that did not come from this origin (typed URL,
 * external link, bookmark) starts a new trail; reloads and back/forward
 * restores keep the existing one.
 */
function isFreshExternalEntry(): boolean {
  try {
    const [entry] = performance.getEntriesByType("navigation");
    const type = (entry as PerformanceNavigationTiming | undefined)?.type;
    return type === "navigate" && !hasSameOriginReferrer();
  } catch {
    return false;
  }
}

export function recordInAppNavigation(pathname: string): void {
  if (typeof window === "undefined") return;
  let base = readStack();
  if (!documentInitialized) {
    documentInitialized = true;
    if (isFreshExternalEntry()) base = [];
  }
  writeStack(nextHistoryStack(base, pathname));
}

export function getInAppHistoryLength(): number {
  if (typeof window === "undefined") return 0;
  return readStack().length;
}

export function hasSameOriginReferrer(): boolean {
  if (typeof window === "undefined" || !document.referrer) return false;
  try {
    return new URL(document.referrer).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * True when `router.back()` is expected to land on a page inside this app.
 */
export function canGoBackInApp(): boolean {
  if (typeof window === "undefined") return false;
  if (window.history.length <= 1) return false;
  return getInAppHistoryLength() > 1 || hasSameOriginReferrer();
}
