/**
 * @jest-environment node
 */

/**
 * The site header is `fixed z-[1000]` and outranks every portal in the app, so
 * an `inset-y-0` Radix sheet on a public page loses its first band behind the
 * navbar. The explore expert drawer did exactly that: portrait, name and
 * headline were invisible. A sheet that lives under that header must subtract
 * the header stack from its top AND bound itself to what is left of the
 * viewport — an offset paired with `height: auto` stops the inner scroll port
 * and drops the footer below the fold.
 */

import { readFileSync } from "fs";
import { join } from "path";

// The contract is the offset expression, not Prettier's line wrapping.
const read = (rel: string) =>
  readFileSync(join(process.cwd(), rel), "utf8").replace(/\s+/g, " ");

/** The one offset every explore surface below the navbar uses. */
const HEADER_STACK =
  "var(--maintenance-banner-height, 0px) + var(--header-height, 5rem)";

describe("explore surfaces clear the fixed site header", () => {
  it("the expert drawer is dropped under the header and bounded to the space left", () => {
    const src = read("app/explore/experts/components/ExpertDetailsSheet.tsx");
    expect(src).toContain(`top: "calc(${HEADER_STACK})"`);
    expect(src).toContain(
      'height: "calc(100dvh - var(--maintenance-banner-height, 0px) - var(--header-height, 5rem))"',
    );
    // The scroller is the body region, so the sheet must not fall back to a
    // content height that leaves the whole drawer unreachable.
    expect(src).not.toContain('height: "auto"');
  });

  it("the drawer shares the offset the other explore surfaces already use", () => {
    // One formula across explore: a hand-rolled copy is how the drawer and the
    // rail drift apart.
    for (const rel of [
      "app/explore/experts/components/StickyFilterBar.tsx",
      "app/explore/components/FacetRail.tsx",
    ]) {
      expect(read(rel)).toContain(`calc(${HEADER_STACK}`);
    }
  });
});
