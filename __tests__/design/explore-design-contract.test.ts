import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Design-system contract tests for the Explore surfaces.
 *
 * The findings these guard against were not typos — they were *accumulated*.
 * Five card treatments, three container widths, four segmented controls, six
 * empty states and 316 hardcoded palette classes were all individually
 * reasonable and collectively incoherent. Nothing failed when they drifted,
 * which is exactly why they got there.
 *
 * So the rules are mechanical, not aesthetic. Anything a reviewer would have to
 * *know* to check is worth automating; anything a designer should be free to
 * change is not.
 */

const ROOT = process.cwd();
const EXPLORE = join(ROOT, "app/explore");

/** Recursively collect .tsx source under a directory. */
function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const FILES = tsxFiles(EXPLORE);
const rel = (f: string) => f.slice(ROOT.length + 1);
const read = (f: string) => readFileSync(f, "utf8");

/** Strips comments so a rule about *code* does not trip on prose describing
 *  the very thing it forbids. */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Two surfaces are excluded, deliberately and with reasons:
 *
 *  - `SatisfiedTestimonial` is a fully-built dark testimonial section that
 *    nothing on /explore/experts renders (only `app/page.tsx` imports it). It
 *    is not this PR's job to redesign it, but it will fail every rule here, so
 *    excluding it is a choice to be explicit about rather than to leave as
 *    noise.
 *  - `community/` and `enterprise/` were parked at the user's request.
 */
const EXCLUDED = [
  "app/explore/experts/components/SatisfiedTestimonial.tsx",
  "app/explore/community",
  "app/explore/enterprise",
];
const IN_SCOPE = FILES.filter(
  (f) => !EXCLUDED.some((x) => f.includes(x)),
);

describe("explore design-system contracts", () => {
  it("has files to check (guards against a bad glob silently passing)", () => {
    expect(IN_SCOPE.length).toBeGreaterThan(20);
  });

  describe("no hardcoded palette", () => {
    // A raw zinc/gray class is how the 316 got there. Semantic tokens exist for
    // every one of these roles, and hardcoding them is what let a card be
    // legible in light mode and unreadable in dark.
    it.each(IN_SCOPE)("%s uses no raw zinc/gray classes", (file) => {
      const offenders = code(file)
        .split("\n")
        .map((line, i) => ({ i: i + 1, line }))
        .filter(({ line }) =>
          /\b(?:text|bg|border|ring|from|via|to|fill|stroke|divide|outline|shadow|decoration|accent|caret|placeholder)-(?:zinc|gray)-\d{2,3}\b/.test(
            line,
          ),
        );
      expect(
        offenders.map((o) => `${rel(file)}:${o.i} ${o.line.trim()}`),
      ).toEqual([]);
    });
  });

  describe("no 10px or 11px text", () => {
    // Both were carrying real information — "reviewed on Familiarise", "this
    // slot needs approval" — below the WCAG 1.4.4 floor for non-bold content.
    it.each(IN_SCOPE)("%s has no text below 12px", (file) => {
      const offenders = code(file)
        .split("\n")
        .filter((l) => /text-\[(?:9|10|11)(?:\.\d+)?px\]/.test(l));
      expect(offenders.map((l) => l.trim())).toEqual([]);
    });
  });

  describe("radius scale is semantic", () => {
    // `rounded-lg` used to mean 12px and `rounded-xl` 16px because the config
    // remapped Tailwind's own keys; `rounded-3xl` stayed at 24px. Adjacent
    // names, near-identical sizes, and a name that lied about its value.
    //
    // `rounded-2xl` / `rounded-3xl` are the two that are still inconsistent
    // with the card radius (a 16px or 24px corner on a 12px card), so those
    // are what is forbidden. The smaller stock keys are now their stock
    // values again and are unremarkable — forbidding them would be churn
    // rather than a rule.
    it.each(IN_SCOPE)("%s uses no over-large stock radius", (file) => {
      const offenders = code(file)
        .split("\n")
        .filter((l) => /\brounded-(?:2xl|3xl)\b/.test(l));
      expect(offenders.map((l) => l.trim())).toEqual([]);
    });

    it("the card radius is the same token everywhere", () => {
      // A programmatically-enforced "every bg-card must be rounded-card" rule
      // was tried and dropped: `bg-card` is also used on nested panels, tab
      // strips and select triggers, where a control radius is correct. Telling
      // a card from a control needs a component boundary, not a regex, and a
      // rule that cries wolf gets deleted. The mechanical part — no
      // over-large stock radius — is enforced above.
      const card = code(FILES.find((f) => f.endsWith("ExploreCard.tsx"))!);
      expect(card).toContain("rounded-card");
    });
  });

  describe("elevation is on the scale", () => {
    // Five shadow values in active use with no rule, and the designed
    // `shadow-elevation-*` scale used by exactly one file before this change.
    //
    // `shadow-md` and `shadow-lg` are allowed on a floating menu or a
    // control, where "raised" is the whole point. What is forbidden is the
    // heavy end of the stock scale (which cards were reaching for to signal
    // importance) and arbitrary `shadow-[...]` values, which is how a card
    // ended up with a hand-written 20px white glow.
    it.each(IN_SCOPE)("%s uses no off-scale shadow", (file) => {
      const offenders = code(file)
        .split("\n")
        .filter(
          (l) => /\bshadow-(?:xl|2xl)\b/.test(l) || /\bshadow-\[[^\]]+\]/.test(l),
        );
      expect(offenders.map((l) => l.trim())).toEqual([]);
    });

    it("the shared card defines the resting elevation", () => {
      const card = code(FILES.find((f) => f.endsWith("ExploreCard.tsx"))!);
      expect(card).toContain("shadow-elevation-1");
      // And the dark-surface edge, so depth reads in both modes without a
      // single `dark:` variant.
      expect(card).toContain("shadow-edge");
    });
  });

  describe("control heights agree", () => {
    // The filter panel used `h-11` selects where the system standard is
    // `h-10`, so a filter row sat a pixel off every other form row.
    it.each(IN_SCOPE)("%s does not invent a control height", (file) => {
      const offenders = code(file)
        .split("\n")
        .filter((l) => /\b(?:SelectTrigger|Input|Textarea)\b[^\n]*\bh-11\b/.test(l));
      expect(offenders.map((l) => l.trim())).toEqual([]);
    });
  });

  describe("no dead conditional styling", () => {
    // Two shipped as visual bugs: a ternary whose branches were the identical
    // string, so the "Weekly vs Custom" pill was constant and the disabled
    // arrow never looked disabled.
    it.each(IN_SCOPE)("%s has no ternary with identical branches", (file) => {
      const offenders = code(file)
        .split("\n")
        .map((line, i) => ({ i: i + 1, line }))
        .filter(({ line }) => {
          const m = line.match(/\?\s*"([^"]*)"\s*:\s*"([^"]*)"/);
          return m !== null && m[1] === m[2];
        });
      expect(
        offenders.map((o) => `${rel(file)}:${o.i} ${o.line.trim()}`),
      ).toEqual([]);
    });
  });

  describe("no no-op hover", () => {
    // `hover:border-border` on a `border-border` element does nothing. It was
    // in six files, so half of every hover treatment was dead.
    it.each(IN_SCOPE)("%s has no hover:border-border", (file) => {
      expect(code(file)).not.toContain("hover:border-border");
    });
  });

  describe("titles do not dim on hover", () => {
    // `group-hover:text-muted-foreground` on a card title is backwards: the
    // title is the label for the action, and dimming it fought the "View
    // details" arrow at the other end of the same card.
    it.each(IN_SCOPE)("%s never dims a title on hover", (file) => {
      const offenders = code(file)
        .split("\n")
        .filter((l) => /group-hover:text-(?:muted-foreground|foreground\/5)0/.test(l));
      expect(offenders.map((l) => l.trim())).toEqual([]);
    });
  });

  describe("one container per surface width", () => {
    // Three coexisting widths. `max-w-[1600px]` was the listing width;
    // `max-w-[92%] xl:max-w-[88%]` was a plan-detail ramp nobody could
    // predict; `max-w-7xl` was the other plan-detail pair.
    it.each(IN_SCOPE)("%s uses no legacy explore widths", (file) => {
      const src = code(file);
      expect(src).not.toMatch(/max-w-\[92%\]/);
      expect(src).not.toMatch(/max-w-\[1600px\]/);
    });

    it("the listing width is declared once, in the shared shell", () => {
      const shell = read(
        join(ROOT, "components/explore/ExploreShell.tsx"),
      );
      expect(shell).toContain("max-w-[1400px]");
      // And the detail width.
      expect(shell).toContain("max-w-[1200px]");
    });
  });

  describe("unknown Tailwind classes", () => {
    // `text-md` is not a class; it resolves to nothing and the heading silently
    // renders at the inherited size. `border-3` is not in the default border
    // width scale (0/2/4/8), so the "spinner" drew no visible ring.
    it.each(IN_SCOPE)("%s uses no non-existent size utilities", (file) => {
      const src = code(file);
      expect(src).not.toMatch(/\btext-md\b/);
      expect(src).not.toMatch(/\bborder-3\b/);
    });
  });

  describe("theme layer", () => {
    it("never mutates documentElement", () => {
      // docs/guides/frontend/02-theming-and-css-scope.md records the failed
      // attempt, and shell-overflow-contract.test.ts bans the escape hatch
      // that papers over it.
      const provider = read(join(ROOT, "components/theme/ThemeProvider.tsx"));
      expect(provider).not.toContain("document.documentElement");
      expect(provider).toContain("document.body");
    });

    it("the dark scope is reachable, not dormant", () => {
      // The block existed and nothing set the class: 365 `dark:` utilities
      // authored across the app and unreachable.
      const css = read(join(ROOT, "app/globals.css"));
      expect(css).toContain('body[data-mode="dark"]');
    });

    it("every direction is defined in both modes", () => {
      const css = read(join(ROOT, "app/globals.css"));
      for (const theme of ["editorial", "gallery"]) {
        expect(css).toContain(`body[data-theme="${theme}"] {`);
        // A direction that collapses to `precision` in dark is not a direction.
        expect(css).toContain(`body[data-theme="${theme}"][data-mode="dark"] {`);
      }
    });

    it("the switcher renders nothing unless it is switched on", () => {
      // It is a review tool, not a product feature; the production DOM must
      // be unchanged when `?themes=1` is absent.
      const switcher = read(join(ROOT, "components/theme/ThemeSwitcher.tsx"));
      expect(switcher).toContain("if (!visible) return null");
      const config = read(join(ROOT, "components/theme/theme-config.ts"));
      expect(config).toContain("switcherEnabled");
    });
  });
});
