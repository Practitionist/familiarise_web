/**
 * Onboarding shell contract.
 *
 * Source-level assertions, in the same style as
 * `__tests__/dashboards/shell-overflow-contract.test.ts`. This repo has no
 * React Testing Library dependency and no component tests by policy, so the
 * invariants a render test would otherwise catch are pinned against the
 * source instead. Each one below is a defect that was actually live, or that
 * this change introduced and had to be fixed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

/**
 * The source with comments removed.
 *
 * Necessary, not cosmetic: several assertions below are NEGATIVE, and the
 * prose explaining a fix names the very string it removed ("no `console.warn`
 * here…"). Matching the raw file fails on its own explanation, which is both
 * noisy and wrong — a comment cannot be a violation. The `[^:]` guard keeps
 * `https://` inside string literals intact.
 */
function readCode(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const PAGE = "app/form/onboarding/page.tsx";
const STEP0 = "app/form/onboarding/components/PersonalInfoAndRoleForm.tsx";
const STEPPER = "components/onboarding/onboarding-stepper.tsx";
const SHELL = "components/onboarding/OnboardingShell.tsx";

describe("onboarding step transition cannot be double-driven", () => {
  // The regression this pins: AnimatePresence `mode="wait"` holds the OUTGOING
  // step on screen, with its Continue button still live, for the whole exit
  // animation. A second click in that window ran handleNext again against the
  // already-incremented step index, so a consultant could jump past
  // Professional Profile without it ever validating.
  it("arms a transition guard on every path that changes the step", () => {
    const src = readCode(PAGE);
    // All three entry points, because the exiting step's own Back button and
    // the stepper's completed-step dots are equally live during the exit.
    expect(src.match(/if \(transitioningRef\.current\) return;/g)).toHaveLength(
      3,
    );
  });

  it("releases the guard when the exit completes, and on a no-step-change error", () => {
    const src = readCode(PAGE);
    expect(src).toContain("onExitComplete");
    expect(src).toMatch(
      /onExitComplete=\{[^}]*transitioningRef\.current = false/,
    );
    // handleNext covers every path where the step does not advance — expired
    // session, the org role handoff failing, the action rejecting — with a
    // single `finally` keyed on whether the step actually changed, so a new
    // failure branch cannot forget to clear the ref.
    expect(src).toMatch(
      /let advanced = false;[\s\S]*?} finally \{\s*if \(!advanced\) transitioningRef\.current = false;/,
    );
  });

  it("releases the guard when backing out of the full-bleed org step", () => {
    // The org step unmounts OnboardingShell (the `fullBleed` early return), so
    // the AnimatePresence that would call onExitComplete is gone. If the guard
    // survived, the shell remounts at step 0 with it armed and every click is
    // ignored — onboarding becomes impossible without a reload.
    const src = readCode(PAGE);
    const at = src.indexOf("const handleExitOrgWizard");
    expect(at).toBeGreaterThan(-1);
    const fn = src.slice(at, at + 600);
    expect(fn).toMatch(
      /transitioningRef\.current = false;[\s\S]{0,120}setStep\(0\)/,
    );
  });

  it("bails on a no-op move before arming the guard", () => {
    // A move to the same index changes no key, so no exit runs and the guard
    // would never be released.
    const src = readCode(PAGE);
    expect(src).toContain("if (step <= 0) return;");
    expect(src).toContain("if (targetStep === step) return;");
  });

  it("passes direction through custom so the EXITING step animates correctly", () => {
    // The exiting element already rendered with the previous direction, so
    // reading `direction` from the closure animates Back with the direction
    // of the last forward move.
    const src = readCode(PAGE);
    expect(src).toMatch(/<AnimatePresence[\s\S]{0,200}custom=\{direction\}/);
    expect(src).toMatch(/custom=\{direction\}[\s\S]{0,120}variants=\{\{/);
  });
});

describe("onboarding stepper markup semantics", () => {
  it("the ordered list holds one item per step, with no aria-hidden list items", () => {
    // The connectors used to be <li> siblings of the step <li>s inside the
    // same <ol>, so AT announced 2N-1 items — nine for a five-step wizard.
    const src = readCode(STEPPER);
    const ol = src.slice(src.indexOf("<ol"), src.indexOf("</ol>"));
    expect(ol).toContain("<li");
    // The connector is an aria-hidden span inside the step's own <li>, and
    // must not be a list item of its own.
    expect(ol).not.toMatch(/<li[^>]*aria-hidden/);
  });

  it("the current step is not a focusable control", () => {
    // It was a `disabled` button carrying aria-current="step": out of the tab
    // order while still advertising itself as current.
    const src = readCode(STEPPER);
    expect(src).toContain('aria-current={isCurrent ? "step" : undefined}');
    expect(src).not.toMatch(/<button[\s\S]{0,400}disabled/);
  });

  it("labels are never truncated away from assistive tech", () => {
    const src = readCode(STEPPER);
    expect(src).not.toContain("truncate");
    // Below sm the visual label is dropped but must stay in the a11y tree, so
    // an item reads as a name rather than a bare number.
    expect(src).toContain("sr-only sm:not-sr-only");
  });
});

describe("onboarding step 0 form semantics", () => {
  it("the role picker is a real radiogroup", () => {
    // It was three bare <button>s calling onChange directly: no radiogroup, no
    // aria-checked, no group label, and the arrow keys did nothing.
    //
    // fieldset + legend IS the radiogroup. An explicit role="radiogroup" on the
    // inner div would nest a second group boundary inside the first, so its
    // absence is asserted as deliberately as its presence would be.
    const src = readCode(STEP0);
    expect(src).toContain("<fieldset");
    expect(src).toContain("<legend");
    expect(src).toContain('type="radio"');
    expect(src).not.toContain('role="radiogroup"');
  });

  it("the email field is readOnly, never disabled", () => {
    // `disabled` took it out of the tab order, skipped it in browse mode and
    // excluded it from submission.
    const src = readCode(STEP0);
    expect(src).toContain("aria-readonly");
    const at = src.indexOf('id="email"');
    expect(at).toBeGreaterThan(-1);
    const emailField = src.slice(at, at + 500);
    expect(emailField).toContain("readOnly");
    expect(emailField).not.toContain("disabled");
  });

  it("the invite panels use design tokens, not raw Tailwind status colours", () => {
    // `border-blue-200 bg-blue-50 text-blue-900` has no dark value, so it
    // rendered pale-on-black inside the shell's dark scope.
    const src = readCode(STEP0);
    for (const banned of [
      "bg-blue-",
      "text-blue-",
      "border-blue-",
      "text-zinc-",
      "text-red-",
    ]) {
      expect(src).not.toContain(banned);
    }
  });

  it("validates on first blur, not mid-keystroke", () => {
    const src = readCode(STEP0);
    expect(src).toContain('mode: "onTouched"');
    expect(src).not.toContain('mode: "onChange"');
  });
});

describe("onboarding shell is token-driven", () => {
  it("mounts a .dark token scope rather than hand-written dark overrides", () => {
    // globals.css already ships a complete .dark block and ~370 dark:
    // utilities that nothing activated. Mounting the scope brings the real
    // system up, so a future app-wide theme is a one-class change.
    const src = readCode(SHELL);
    expect(src).toMatch(/"dark\b/);
    expect(src).not.toContain("dark:");
  });

  it("uses the maintenance-banner offset, not a bare sticky top-0", () => {
    // The root layout renders a fixed MaintenanceBanner at z-[10001] above
    // this route; a bare top-0 pinned the header underneath it.
    const src = readCode(SHELL);
    expect(src).toContain("top-maintenance");
    expect(src).not.toMatch(/sticky top-0/);
  });

  it("uses the stable small viewport and the elevation scale", () => {
    expect(readCode(SHELL)).toContain("min-h-svh");
    expect(readCode(SHELL)).not.toMatch(/\bmin-h-screen\b/);
    const page = readCode(PAGE);
    expect(page).toContain("shadow-elevation-2");
    expect(page).not.toContain("shadow-lg");
  });

  it("a wide step gets a fixed breakpoint width, not a percentage", () => {
    // `max-w-[80%]` scaled the card continuously with the viewport, so the
    // weekly slot grid reflowed unpredictably between breakpoints.
    const src = readCode(SHELL);
    expect(src).toContain("max-w-[80rem]");
    expect(src).not.toMatch(/max-w-\[\d+%\]/);
  });

  it("the decorative canvas uses the light-on-dark pattern class", () => {
    // The "-dark" suffix names the LINE colour, not the surface:
    // `dot-pattern-dark` is rgba(0,0,0,.05) and would be invisible here.
    const src = readCode(SHELL);
    expect(src).toContain("mesh-gradient-dark");
    expect(src).toContain("dot-pattern");
    expect(src).not.toContain("dot-pattern-dark");
  });
});

describe("onboarding submit path does not leak submitted values", () => {
  it("captures a synthetic error name, never the raw exception", () => {
    // This path can carry submitted field values, and captureException ships
    // the message, stack and attached context to the telemetry SDK.
    const src = readCode(PAGE);
    const at = src.indexOf("Sentry.captureException");
    expect(at).toBeGreaterThan(-1);
    const capture = src.slice(at, at + 400);
    expect(capture).toContain("new Error(");
    expect(capture).toContain("error.name");
    expect(capture).not.toMatch(/captureException\(\s*error\b/);
  });

  it("leaves no console logging on the submit path", () => {
    const src = readCode(PAGE);
    expect(src).not.toContain("console.warn");
    expect(src).not.toContain("console.error");
  });
});
