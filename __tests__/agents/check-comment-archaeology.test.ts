import {
  BANNED,
  commentOf,
  findViolations,
} from "../../scripts/ci/check-comment-archaeology";

describe("check-comment-archaeology", () => {
  it.each([
    ["// Fix #1234 by retrying", true],
    ["// see #568", true],
    ["/* follow-up to #12 */", true],
    ["// P1-W02a split", true],
    ["// owner decision Q3", true],
    ["// Use #000 for text on white", false],
    ["// docs: https://example.com/page#12345", false],
    ["// a 3-digit #568 alone is not flagged", false],
    ["// colour #123456", false],
  ])("BANNED on %s is %s", (comment, banned) => {
    expect(BANNED.test(comment)).toBe(banned);
  });

  it("skips comment markers inside string literals", () => {
    expect(commentOf('const example = "// Fix #1234";')).toBeNull();
    expect(commentOf("const u = `http://x/#1234`;")).toBeNull();
    expect(commentOf('const s = "a"; // Fix #1234')).toBe("// Fix #1234");
  });

  it("reads -- comments only in SQL, and keeps quotes literal there", () => {
    expect(commentOf("SELECT '--x' -- fix #1234", true)).toBe("-- fix #1234");
    expect(commentOf("const a = b -- c")).toBeNull();
  });

  it("reports only added comment lines with their new line numbers", () => {
    const diff = [
      "+++ b/lib/x.ts",
      "@@ -1,0 +10,3 @@",
      "+const a = 1; // Fix #1234",
      '+const b = "// Fix #4321";',
      "+// background #000",
    ].join("\n");
    expect(findViolations(diff)).toEqual(["lib/x.ts:10: // Fix #1234"]);
  });
});
