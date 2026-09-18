/**
 * After a refused submit, bring the first problem into view and put focus on
 * its control. react-hook-form only focuses inputs it registered itself;
 * Controller-driven pickers, sections that manage their own error state and
 * the shell's toast-only refusals get nothing, so a long step could refuse
 * with the reason off-screen. Looks for `aria-invalid` controls first, then
 * the `FieldError` markers, so both idioms work.
 */

const CONTROL = "input, select, textarea, button, [tabindex]";

function controlFor(marker: Element): HTMLElement | null {
  if (marker.matches(CONTROL)) return marker as HTMLElement;
  // A FieldError sits after its control inside the same field wrapper.
  const wrapper = marker.parentElement;
  const sibling = wrapper?.querySelector<HTMLElement>(CONTROL);
  return sibling ?? null;
}

export function scrollToFirstError(root: ParentNode = document): boolean {
  if (typeof window === "undefined") return false;
  const marker =
    root.querySelector<HTMLElement>('[aria-invalid="true"]') ??
    root.querySelector<HTMLElement>("[data-field-error]");
  if (!marker) return false;
  const target = controlFor(marker) ?? marker;
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  // preventScroll: the smooth scroll above owns the viewport.
  if (typeof target.focus === "function") {
    target.focus({ preventScroll: true });
  }
  return true;
}

/** Defer one frame so the refused render has painted its error markers. */
export function scrollToFirstErrorSoon(root?: ParentNode): void {
  if (typeof window === "undefined") return;
  window.requestAnimationFrame(() => {
    scrollToFirstError(root);
  });
}
