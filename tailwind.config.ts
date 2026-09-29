import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  // `lib/` and `utils/` hold class strings too — the slot palette, appointment
  // status badges, session and org labels, document icons. Tailwind only emits
  // a utility it has SEEN in a scanned file, so every one of those was being
  // dropped from the stylesheet unless the same class happened to appear under
  // components/ or app/ as well. That is what made grid cells painted from
  // `lib/scheduling/slot-status-tokens` render with no fill and no border at
  // all — not faint, absent (#1064).
  content: [
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
    "./utils/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        // Inter is the text face. Sora is retained behind `display` for the
        // marketing/landing typography that still asks for it — it is no longer
        // the body face, because a geometric display face rendering every
        // 13–15px UI string was the single largest contributor to this app
        // reading as a template. See lib/fonts.ts.
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        display: ["var(--font-sora)", "var(--font-inter)", "system-ui", "sans-serif"],
        // There was no mono key at all before, so any code or ID fell through
        // to the browser default. Tabular figures and the FIG-style metadata
        // labels in the explore surfaces both want a real one.
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-conic":
          "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
        "gradient-silver":
          "linear-gradient(135deg, #ffffff, #d4d4d4, #a3a3a3, #d4d4d4, #ffffff)",
        "gradient-dark": "linear-gradient(135deg, #0a0a0a, #1f1f1f, #0a0a0a)",
        "gradient-metallic":
          "linear-gradient(145deg, #2a2a2a 0%, #1a1a1a 50%, #0f0f0f 100%)",
        "gradient-steel": "linear-gradient(180deg, #3f3f46, #27272a, #18181b)",
      },
      screens: {
        sm: "640px",
        md: "768px",
        lg: "1024px",
        xl: "1280px",
        "2xl": "1400px",
        landscape: { raw: "(orientation: landscape)" },
        portrait: { raw: "(orientation: portrait)" },
        "landscape-compact": {
          raw: "(orientation: landscape) and (max-height: 500px)",
        },
      },
      borderRadius: {
        // SEMANTIC, not an arithmetic remap of Tailwind's defaults.
        //
        // The previous block overwrote `lg`/`md`/`sm`/`xl`/`2xl` with
        // `--radius` ± N px while leaving `3xl` and `full` at their stock
        // values. The visible result was `rounded-lg` = 12px, `rounded-xl` =
        // 16px, `rounded-2xl` = 20px, `rounded-3xl` = 24px — adjacent names,
        // near-identical sizes, and names that no longer matched their stock
        // meaning. Any developer writing `rounded-xl` from muscle memory got
        // something nobody else expected.
        //
        // These four are picked by ROLE, so the values can differ per theme
        // (the editorial direction ships 6/8px) without touching call sites.
        // The stock keys below are kept so existing call sites keep working
        // while they migrate; new code uses the semantic ones.
        control: "var(--radius-control)",
        // 6px — the small-pill step (badges, tags, status chips). Deliberately
        // tighter than `control`: at a 20px badge height an 8px radius reads
        // as a lozenge, which is the wrong signal for a status label.
        chip: "var(--radius-chip)",
        card: "var(--radius-card)",
        media: "var(--radius-media)",
        pill: "var(--radius-pill)",
        // Stock scale, no longer remapped.
        none: "0px",
        sm: "0.25rem",
        DEFAULT: "0.25rem",
        md: "0.375rem",
        lg: "0.5rem",
        xl: "0.75rem",
        "2xl": "1rem",
        "3xl": "1.5rem",
        full: "9999px",
      },
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // The surface ladder. `--background` is the page, `--surface` is a
        // banded section on it, `--card` sits above both. On the old scale all
        // three were the same value, so a card had nothing to be a card
        // against and separation had to come from a shadow — which is how the
        // same surface ended up using shadow-xl in one file and shadow-md in
        // another.
        surface: {
          DEFAULT: "hsl(var(--surface))",
          raised: "hsl(var(--surface-raised))",
          sunken: "hsl(var(--surface-sunken))",
        },
        // The brand accent, kept separate from `--primary` on purpose:
        // `--primary` is load-bearing across every dashboard in this app, so
        // repainting it would re-skin 400+ out-of-scope files. The explore
        // surfaces consume `--brand`; promoting it app-wide later is a
        // one-line alias flip here rather than a second migration.
        brand: {
          DEFAULT: "hsl(var(--brand))",
          foreground: "hsl(var(--brand-foreground))",
          subtle: "hsl(var(--brand-subtle))",
          "foreground-subtle": "hsl(var(--brand-foreground-subtle))",
          border: "hsl(var(--brand-border))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
        },
        error: {
          DEFAULT: "hsl(var(--error))",
          foreground: "hsl(var(--error-foreground))",
        },
        border: "hsl(var(--border))",
        "border-subtle": "hsl(var(--border-subtle))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        chart: {
          "1": "hsl(var(--chart-1))",
          "2": "hsl(var(--chart-2))",
          "3": "hsl(var(--chart-3))",
          "4": "hsl(var(--chart-4))",
          "5": "hsl(var(--chart-5))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      fontSize: {
        // Fluid type scale — additive keys (text-fluid-*); defaults untouched
        "fluid-xs": ["var(--fs-xs)", { lineHeight: "1.5" }],
        "fluid-sm": ["var(--fs-sm)", { lineHeight: "1.5" }],
        "fluid-base": ["var(--fs-base)", { lineHeight: "1.6" }],
        "fluid-lg": ["var(--fs-lg)", { lineHeight: "1.5" }],
        "fluid-xl": [
          "var(--fs-xl)",
          { lineHeight: "1.4", letterSpacing: "-0.01em" },
        ],
        "fluid-2xl": [
          "var(--fs-2xl)",
          { lineHeight: "1.3", letterSpacing: "-0.015em" },
        ],
        "fluid-3xl": [
          "var(--fs-3xl)",
          { lineHeight: "1.2", letterSpacing: "-0.02em" },
        ],
        "fluid-4xl": [
          "var(--fs-4xl)",
          { lineHeight: "1.1", letterSpacing: "-0.02em" },
        ],
        "fluid-5xl": [
          "var(--fs-5xl)",
          { lineHeight: "1.05", letterSpacing: "-0.025em" },
        ],
      },
      boxShadow: {
        // Elevation, on an explicitly named scale (additive keys
        // `shadow-elevation-*`, stock `shadow-sm`..`shadow-2xl` untouched).
        //
        // Two things were wrong with the previous version. It defined exactly
        // three steps, which cannot express "resting card" vs "hovered card"
        // vs "modal" without one of them doing double duty — so pages reached
        // for stock `shadow-md`/`shadow-lg`/`shadow-xl`, and the same card
        // meant three different things in three files. And it was used by
        // exactly one file (`components/ui/card.tsx`), which every plan-detail
        // section then overrode with `shadow-sm`, so the system was dead on
        // arrival.
        //
        // Shadows are tinted by `--shadow-color` (which carries the theme's
        // hue) rather than pure black, so they read as light falling on a
        // coloured surface instead of as grey smudge. Keep the alphas low;
        // the surface ladder does most of the separation work.
        "elevation-0": "none",
        "elevation-1":
          "0 1px 2px -1px hsl(var(--shadow-color) / 0.06), 0 1px 3px hsl(var(--shadow-color) / 0.04)",
        "elevation-2":
          "0 2px 4px -2px hsl(var(--shadow-color) / 0.08), 0 4px 10px -3px hsl(var(--shadow-color) / 0.06)",
        "elevation-3":
          "0 4px 8px -4px hsl(var(--shadow-color) / 0.1), 0 12px 24px -6px hsl(var(--shadow-color) / 0.08)",
        "elevation-4":
          "0 8px 16px -8px hsl(var(--shadow-color) / 0.12), 0 24px 48px -12px hsl(var(--shadow-color) / 0.12)",
        /**
         * The dark-surface depth channel. A drop shadow on a near-black card
         * is imperceptible, so on dark the edge has to come from inside: a 1px
         * white-at-6% top highlight, which reads as a lit edge. `--highlight`
         * is transparent in light mode, so this is a no-op there and the two
         * modes need no variant classes.
         */
        edge: "inset 0 1px 0 0 hsl(var(--highlight) / 0.06)",
        "edge-2":
          "inset 0 1px 0 0 hsl(var(--highlight) / 0.08), 0 1px 2px hsl(var(--shadow-color) / 0.2)",
      },
      keyframes: {
        "accordion-down": {
          from: {
            height: "0",
          },
          to: {
            height: "var(--radix-accordion-content-height)",
          },
        },
        "accordion-up": {
          from: {
            height: "var(--radix-accordion-content-height)",
          },
          to: {
            height: "0",
          },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
export default config;
