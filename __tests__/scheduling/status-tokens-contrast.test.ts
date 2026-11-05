/**
 * WCAG 1.4.11 (non-text contrast) and 1.4.1 (use of colour) for the grid
 * status tokens, computed from Tailwind's own palette rather than eyeballed.
 */
import colors from "tailwindcss/colors";

import {
  SLOT_STATUS_KEYS,
  SLOT_STATUS_TOKENS,
  type SlotStatusKey,
} from "@/lib/scheduling/interval-status-tokens";

const palette = new Map<string, Record<string, string>>();
for (const [name, value] of Object.entries(colors)) {
  if (typeof value === "object") palette.set(name, value);
}

/** `bg-emerald-600` / `border-slate-500` / `text-white` → hex. */
function hexOf(utility: string): string | null {
  const name = utility.replace(/^(bg|border|text)-/, "");
  if (name === "white") return "#ffffff";
  if (name === "black") return "#000000";
  if (name === "transparent") return null;
  const match = /^([a-z]+)-(\d{2,3})$/.exec(name);
  if (!match) throw new Error(`Not a palette utility: ${utility}`);
  const family = palette.get(match[1]);
  if (!family) throw new Error(`Unknown family ${utility}`);
  const hex = family[match[2]];
  if (!hex) throw new Error(`Unknown shade ${utility}`);
  return hex;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(
    (i) => parseInt(hex.slice(i, i + 2), 16) / 255,
  );
  const [r, g, b] = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const CARD = "#ffffff";
const ACTIVE = SLOT_STATUS_KEYS.filter(
  (key) => !SLOT_STATUS_TOKENS[key].contrastExempt,
);

describe("status tokens — non-text contrast (WCAG 1.4.11)", () => {
  it("exempts only the inactive, decorative states", () => {
    expect(
      SLOT_STATUS_KEYS.filter((key) => SLOT_STATUS_TOKENS[key].contrastExempt),
    ).toEqual(["past", "unavailable"]);
  });

  it.each(ACTIVE)("%s: its border clears 3:1 against the card", (key) => {
    const border = hexOf(SLOT_STATUS_TOKENS[key].border);
    expect(border).not.toBeNull();
    expect(contrast(border as string, CARD)).toBeGreaterThanOrEqual(3);
  });

  it.each(SLOT_STATUS_KEYS)(
    "%s: its label clears 4.5:1 against its own fill",
    (key) => {
      const token = SLOT_STATUS_TOKENS[key];
      const fill = hexOf(token.fill) ?? CARD;
      const text = hexOf(token.text) as string;
      expect(contrast(text, fill)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("the selected fill itself stands out from the card", () => {
    const fill = hexOf(SLOT_STATUS_TOKENS.selected.fill) as string;
    expect(contrast(fill, CARD)).toBeGreaterThanOrEqual(3);
  });
});

describe("status tokens — never colour alone (WCAG 1.4.1)", () => {
  const cueOf = (key: SlotStatusKey) => {
    const token = SLOT_STATUS_TOKENS[key];
    return token.pattern ?? token.icon ?? null;
  };

  it.each(ACTIVE.filter((key) => key !== "available"))(
    "%s carries a pattern or a glyph",
    (key) => {
      expect(cueOf(key)).not.toBeNull();
    },
  );

  it("no two active states share the same non-colour cue", () => {
    const cues = ACTIVE.map(cueOf).filter(Boolean);
    expect(new Set(cues).size).toBe(cues.length);
  });

  it("free is the only plain state, so plain itself is its cue", () => {
    expect(cueOf("available")).toBeNull();
    expect(SLOT_STATUS_TOKENS.available.label).toBe("Free");
  });
});
