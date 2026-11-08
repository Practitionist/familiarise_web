/**
 * @jest-environment node
 */

/**
 * The site header is `fixed z-[1000]`. Surfaces that sit IN the page below it
 * (the sticky filter bar, the facet rail) subtract the header stack from their
 * top. Modals do not: Dialog, Sheet and AlertDialog layer above the header
 * (`__tests__/ui/overlay-layers.test.ts`), so the expert drawer is an ordinary
 * full-height sheet. A hand-rolled copy of the header offset on it would push
 * it down and leave a band of header uncovered above its overlay.
 */

import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/** The one offset every explore surface below the navbar uses. */
const HEADER_STACK =
  "var(--maintenance-banner-height, 0px) + var(--header-height, 5rem)";

describe("explore surfaces clear the fixed site header", () => {
  it("the expert drawer is a full-height modal sheet, not offset below the header", () => {
    const src = read("app/explore/experts/components/ExpertDetailsSheet.tsx");
    expect(src).not.toContain("--header-height");
    // The scroller is the body region, so the sheet must not fall back to a
    // content height that leaves the whole drawer unreachable.
    expect(src).not.toContain('height: "auto"');
  });

  it("in-page surfaces share the one header offset", () => {
    // One formula across explore: a hand-rolled copy is how the bar and the
    // rail drift apart.
    for (const rel of [
      "app/explore/experts/components/StickyFilterBar.tsx",
      "app/explore/components/FacetRail.tsx",
    ]) {
      expect(read(rel)).toContain(`calc(${HEADER_STACK}`);
    }
  });
});
