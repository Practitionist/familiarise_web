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
 * Assertions run against the RAW source, comments included — no stripping.
 *
 * Two earlier versions stripped comments first, and both were wrong in a way
 * that matters, because a stripper that also eats string literals can turn a
 * negative assertion green for the wrong reason:
 *
 *   - a `(^|[^:])\/\/.*$` regex, whose `[^:]` guard only rescues `://` and
 *     which therefore truncated `const s = "a//b"`;
 *   - a small lexer over code / comment / string / template states, which
 *     desynced on JSX text — a raw apostrophe in prose opened a "string" and
 *     every later comment stopped being blanked.
 *
 * The resolution is not a better stripper. It is that these assertions are
 * about the CODE, so the comments are written not to contain the tokens being
 * asserted absent: they describe the old colour in words ("the raw Tailwind
 * red", "the redundant radiogroup role") rather than pasting the class. That
 * makes a negative assertion provably about code, with no comment-stripping
 * step that could be wrong in either direction.
 */

const PAGE = "app/form/onboarding/page.tsx";
const STEP0 = "app/form/onboarding/components/PersonalInfoAndRoleForm.tsx";
const STEPPER = "components/onboarding/onboarding-stepper.tsx";
const SHELL = "components/onboarding/OnboardingShell.tsx";
const LAYOUT = "app/form/onboarding/layout.tsx";
const UPLOAD = "components/verification/VerificationDocumentUpload.tsx";
const GLOBALS = "app/globals.css";

/** WCAG relative luminance + contrast ratio, so token changes are judged by
 *  measurement rather than by eye. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
function luminance([r, g, b]: [number, number, number]): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
function contrast(a: [number, number, number], b: [number, number, number]) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** Pull `--name: H S% L%` out of a token block. */
function token(css: string, block: string, name: string) {
  const body = css.slice(css.indexOf(block));
  const m = body.match(
    new RegExp(`${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`),
  );
  if (!m) throw new Error(`token --${name} not found in ${block}`);
  return hslToRgb(+m[1], +m[2] / 100, +m[3] / 100);
}

describe("onboarding step transition cannot be double-driven", () => {
  // The regression this pins: AnimatePresence `mode="wait"` holds the OUTGOING
  // step on screen, with its Continue button still live, for the whole exit
  // animation. A second click in that window ran handleNext again against the
  // already-incremented step index, so a consultant could jump past
  // Professional Profile without it ever validating.
  it("arms a transition guard on every path that changes the step", () => {
    const src = read(PAGE);
    // All three entry points, because the exiting step's own Back button and
    // the stepper's completed-step dots are equally live during the exit.
    // handleGoToStep returns a boolean so the resume banner knows whether the
    // jump was taken, hence `return;` for the two void handlers and
    // `return false;` for that one.
    expect(
      src.match(/if \(transitioningRef\.current\) return( false)?;/g),
    ).toHaveLength(3);
  });

  it("releases the guard when the exit completes, and on a no-step-change error", () => {
    const src = read(PAGE);
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
    const src = read(PAGE);
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
    const src = read(PAGE);
    expect(src).toMatch(/if \(step <= 0\) return( false)?;/);
    expect(src).toMatch(/if \(targetStep === step\) return( false)?;/);
  });

  it("the resume-banner jump goes through the guard, not a bare setStep", () => {
    // The step-0 form stays mounted and live for the whole exit animation, so
    // a bare setStep(resumeStep) could be followed by an Enter keypress or a
    // click on the still-present Continue — and handleNext would advance from
    // the index the user just asked for, landing short and skipping a step's
    // validation.
    //
    // The stored step is cleared only when the jump was actually taken: a
    // rejected jump (a transition already in flight) would otherwise destroy
    // the shortcut without moving the user anywhere.
    const src = read(PAGE);
    const at = src.indexOf("Resume at step");
    expect(at).toBeGreaterThan(-1);
    expect(src).not.toMatch(/setStep\(resumeStep\)/);
    expect(src).toContain(
      "if (handleGoToStep(resumeStep)) setResumeStep(null);",
    );
  });

  it("every backward setStep also sets the animation direction", () => {
    // `direction` exists so "Back" does not animate identically to "Next". A
    // setStep that decreases the index without setting direction plays the
    // forward slide while moving backwards. The draft-restore branch is exempt
    // because it can only ever move forward from step 0.
    const src = read(PAGE);
    // startOver, handleExitOrgWizard, the validation-failure jump, the
    // refused-step jump, and the stepper jump in handleGoToStep. That last one
    // uses `>=` rather than `>`, so the pattern allows either.
    expect(src.match(/setDirection\(-1\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(
      src.match(
        /setDirection\((?:refusedStep|targetStep) >=? step \? 1 : -1\)/g,
      ),
    ).toHaveLength(3);
  });

  it("passes direction through custom so the EXITING step animates correctly", () => {
    // The exiting element already rendered with the previous direction, so
    // reading `direction` from the closure animates Back with the direction
    // of the last forward move.
    const src = read(PAGE);
    expect(src).toMatch(/<AnimatePresence[\s\S]{0,200}custom=\{direction\}/);
    expect(src).toMatch(/custom=\{direction\}[\s\S]{0,120}variants=\{\{/);
  });
});

describe("onboarding stepper markup semantics", () => {
  it("the ordered list holds one item per step, with no aria-hidden list items", () => {
    // The connectors used to be <li> siblings of the step <li>s inside the
    // same <ol>, so AT announced 2N-1 items — nine for a five-step wizard.
    const src = read(STEPPER);
    const ol = src.slice(src.indexOf("<ol"), src.indexOf("</ol>"));
    expect(ol).toContain("<li");
    // The connector is an aria-hidden span inside the step's own <li>, and
    // must not be a list item of its own.
    expect(ol).not.toMatch(/<li[^>]*aria-hidden/);
  });

  it("the current step is not a focusable control", () => {
    // It was a `disabled` button carrying aria-current="step": out of the tab
    // order while still advertising itself as current.
    const src = read(STEPPER);
    expect(src).toContain('aria-current={isCurrent ? "step" : undefined}');
    expect(src).not.toMatch(/<button[\s\S]{0,400}disabled/);
  });

  it("labels are never truncated away from assistive tech", () => {
    const src = read(STEPPER);
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
    const src = read(STEP0);
    expect(src).toContain("<fieldset");
    expect(src).toContain("<legend");
    expect(src).toContain('type="radio"');
    expect(src).not.toContain('role="radiogroup"');
  });

  it("the email field is readOnly, never disabled", () => {
    // `disabled` took it out of the tab order, skipped it in browse mode and
    // excluded it from submission.
    const src = read(STEP0);
    expect(src).toContain("aria-readonly");
    const at = src.indexOf('id="email"');
    expect(at).toBeGreaterThan(-1);
    const emailField = src.slice(at, at + 500);
    expect(emailField).toContain("readOnly");
    expect(emailField).not.toContain("disabled");
  });

  it("the invite panels use design tokens, not raw Tailwind status colours", () => {
    // `border-blue-200 bg-blue-50 text-blue-900` has no dark value, so it
    // rendered pale-on-black inside the dark scope.
    //
    // The earlier version of this asserted a hand-listed set of five prefixes
    // (blue, zinc, red), which was a false pass: swapping the invite panel back
    // to `border-amber-200 bg-amber-50` left the suite green. Every raw
    // palette is now covered, over every Tailwind colour-carrying utility.
    // `primary`/`muted`/`destructive` and friends are tokens and deliberately
    // absent from the list.
    const src = read(STEP0);
    const RAW_PALETTE =
      "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
    const UTILITY = `\\b(?:bg|text|border|ring|from|to|via|fill|stroke|divide|outline|decoration|accent|caret|shadow)-`;
    expect(src).not.toMatch(new RegExp(`${UTILITY}(?:${RAW_PALETTE})-\\d`));
  });

  it("validates on first blur, not mid-keystroke", () => {
    const src = read(STEP0);
    expect(src).toContain('mode: "onTouched"');
    expect(src).not.toContain('mode: "onChange"');
  });
});

describe("onboarding shell is token-driven", () => {
  it("scopes the dark tokens off body:has(.onboarding-shell), with no JS", () => {
    // Radix portals (Select, Dialog, Popover, DropdownMenu, Tooltip) mount to
    // document.body, which is OUTSIDE the shell subtree. A class on the shell
    // left every dropdown and modal resolving --popover / --background against
    // :root -- a white panel over a near-black card. Keying the tokens off
    // `body` reaches those portals directly.
    //
    // Pure CSS, so there is no pre-paint window and no hydration to mismatch.
    // That matters here specifically: the pre-paint inline script this
    // replaced mutated <html> before hydration, which React reports as a
    // mismatch, and the documented remedy -- suppressHydrationWarning on
    // <html> -- is forbidden by
    // __tests__/dashboards/shell-overflow-contract.test.ts:156.
    const css = read(GLOBALS);
    // The dark values are declared once, for two selectors: the onboarding
    // route (which is dark-only by design) and the user-selectable
    // `data-mode` axis. The `.dark` class this used to be keyed on is gone —
    // nothing ever set it, which is why the whole block and its ~370 `dark:`
    // utilities sat authored but unreachable.
    expect(css).toMatch(
      /body\[data-mode="dark"\],\s*body:has\(\.onboarding-shell\)\s*\{/,
    );
    // The class route must not come back: setting a class on <html> is what
    // `02-theming-and-css-scope.md` records the failed attempt at.
    expect(css).not.toMatch(/^\s*\.dark\s*,/m);
    // The shell carries the marker class...
    expect(read(SHELL)).toMatch(/"onboarding-shell /);
    // ...and no JavaScript mutates the document element anywhere in it.
    expect(read(SHELL)).not.toContain("documentElement");
    expect(read(SHELL)).not.toContain("classList");
    // A pre-paint script needs <head>, which a nested layout cannot emit.
    expect(read(LAYOUT)).not.toContain("dangerouslySetInnerHTML");
    expect(read(LAYOUT)).not.toContain("<script");
  });

  it("the layout stays a bare auth guard, so it cannot force the route dynamic", () => {
    const layout = read(LAYOUT);
    expect(layout).toContain("requireNotOnboarded");
    expect(layout).not.toContain("headers(");
  });

  it("the destructive token is legible on the dark card", () => {
    // Was hsl(0 62.8% 30.6%) = #7f1d1d: a SURFACE colour, not a text colour.
    // 1.87:1 on --card, so every text-destructive in a dark scope was
    // effectively invisible — and FieldError, the validation copy a person must
    // read, is the heaviest user of that class.
    const css = read(GLOBALS);
    // The shared dark block. Its selector is now
    // `body[data-mode="dark"], body:has(.onboarding-shell)` — see the note in
    // app/globals.css.
    const dark = 'body[data-mode="dark"]';
    const card = token(css, dark, "--card");
    const bg = token(css, dark, "--background");
    const destructive = token(css, dark, "--destructive");
    // AA body text is 4.5:1.
    expect(contrast(destructive, card)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(destructive, bg)).toBeGreaterThanOrEqual(4.5);
    // Light mode must be untouched by the dark fix.
    expect(
      contrast(
        token(css, ":root", "--destructive"),
        token(css, ":root", "--background"),
      ),
    ).toBeGreaterThan(1);
  });

  it("the upload widget inside the dark scope uses tokens only", () => {
    // Rendered on step 4 (Agreement & Verification). Its raw zinc/red/green
    // classes had no dark value: the document rows were #fafafa chips on a
    // #121212 card and the dropzone instruction sat at 2.42:1.
    const src = read(UPLOAD);
    const RAW_PALETTE =
      "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
    const UTILITY = `\\b(?:bg|text|border|ring|from|to|via|fill|stroke|divide|outline|decoration|accent|caret)-`;
    expect(src).not.toMatch(new RegExp(`${UTILITY}(?:${RAW_PALETTE})-\\d`));
    expect(src).toContain("text-destructive");
    expect(src).toContain("text-success");
  });

  it("the sticky header clears BOTH fixed banners", () => {
    // `top-maintenance` covers MaintenanceBanner only. AnnouncementBar is
    // fixed at top-maintenance z-[1001] and is NOT gated by NO_CHROME, so it
    // renders on /form/ and a header at plain top-maintenance slides under it.
    const src = read(SHELL);
    expect(src).toMatch(
      /top-\[calc\(var\(--maintenance-banner-height[^)]*\)\+var\(--announcement-bar-height/,
    );
    expect(src).not.toMatch(/sticky top-0/);
  });

  it("uses the stable small viewport and the elevation scale", () => {
    expect(read(SHELL)).toContain("min-h-svh");
    expect(read(SHELL)).not.toMatch(/\bmin-h-screen\b/);
    const page = read(PAGE);
    expect(page).toContain("shadow-elevation-2");
    expect(page).not.toContain("shadow-lg");
  });

  it("a wide step gets a fixed breakpoint width, not a percentage", () => {
    // `max-w-[80%]` scaled the card continuously with the viewport, so the
    // weekly slot grid reflowed unpredictably between breakpoints.
    const src = read(SHELL);
    expect(src).toContain("max-w-[80rem]");
    expect(src).not.toMatch(/max-w-\[\d+%\]/);
  });

  it("the decorative canvas uses the light-on-dark pattern class", () => {
    // The "-dark" suffix names the LINE colour, not the surface:
    // `dot-pattern-dark` is rgba(0,0,0,.05) and would be invisible here.
    const src = read(SHELL);
    expect(src).toContain("mesh-gradient-dark");
    expect(src).toContain("dot-pattern");
    expect(src).not.toContain("dot-pattern-dark");
  });
});

describe("onboarding submit path does not leak submitted values", () => {
  it("captures a synthetic error name, never the raw exception", () => {
    // This path can carry submitted field values, and captureException ships
    // the message, stack and attached context to the telemetry SDK.
    //
    // Scoped to the FIRST call site this was a false pass: adding a second
    // `Sentry.captureException(error)` further down the file left the suite
    // green, even though the assertion claims the raw exception never reaches
    // telemetry. So the check is now over EVERY call site in the file, and the
    // count is pinned so a second capture cannot slip in either.
    const src = read(PAGE);
    const sites = src.match(/captureException\(/g) ?? [];
    expect(sites).toHaveLength(1);
    // No call site may hand over a bare error-ish identifier. Named the same
    // way the caught binding is, plus the other conventional short names, so
    // a rename cannot quietly reintroduce the leak.
    expect(src).not.toMatch(
      /captureException\(\s*(error|err|e|exc|exception)\b/,
    );
    const at = src.indexOf("captureException(");
    expect(src.slice(at, at + 400)).toContain("new Error(");
    expect(src.slice(at, at + 400)).toContain("error.name");
  });

  it("leaves no console logging on the submit path", () => {
    const src = read(PAGE);
    expect(src).not.toContain("console.warn");
    expect(src).not.toContain("console.error");
  });
});
