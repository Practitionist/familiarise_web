/**
 * @jest-environment node
 */

/**
 * The recommended refund amount is typed in rupees by an operator and turned
 * into paise for a RECOMMEND_REFUND action. Binary float maths rounds
 * "1.005" to 100 paise, so the recommended refund can differ from what was
 * typed. The shared decimal parser is unit-tested below; the panel is pinned
 * at source level so it cannot go back to float maths.
 */

import fs from "fs";
import path from "path";
import { rupeesToPaise } from "../../lib/backoffice/rupees";

const PANEL = "components/support/CaseResolutionPanel.tsx";

function read(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

describe("rupeesToPaise — the panel's amount parser", () => {
  it("reads a plain rupee amount as exact paise", () => {
    expect(rupeesToPaise("10.50")).toBe(1050);
    expect(rupeesToPaise("1.5")).toBe(150);
    expect(rupeesToPaise("1234")).toBe(123400);
  });

  it("refuses more than two decimals instead of rounding them away", () => {
    // 1.005 * 100 is 100.49999… — a float round lands a paise short.
    expect(rupeesToPaise("1.005")).toBeNull();
  });

  it("refuses exponent notation", () => {
    expect(rupeesToPaise("1e3")).toBeNull();
  });
});

describe("CaseResolutionPanel — the recommended amount", () => {
  it("derives paise through the shared decimal parser", () => {
    const src = read(PANEL);
    expect(src).toMatch(/from "@\/lib\/backoffice\/rupees"/);
    expect(src).toMatch(/rupeesToPaise\(amount\)/);
  });

  it("never derives paise from float maths", () => {
    expect(read(PANEL)).not.toMatch(/Math\.round\(Number\(/);
  });
});
