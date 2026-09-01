/**
 * The sidecar SQL splitter (`scripts/db/sql-chunks.ts`).
 *
 * `db:push` chains into `db:sidecars`, which replays three `prisma/sql/*.sql`
 * files through this splitter to recreate the ledger trigger, the payment-leg
 * funding-sum trigger and the CHECK constraints. Dropping a chunk here would
 * silently leave a money-path invariant unenforced on a fresh database, so the
 * ReDoS fix that introduced this module has to be provably behaviour-preserving
 * rather than merely plausible.
 */
import { readFileSync } from "fs";
import path from "path";

import {
  isOnlyComments,
  splitSqlStatements,
} from "../../scripts/db/sql-chunks";

/**
 * The predicate this module replaced: `typescript:S5852`, exponential
 * backtracking, the sole CRITICAL security finding on `dev`. Kept here as the
 * oracle so the equivalence claim in the module's docblock is checked rather
 * than asserted.
 */
const legacyIsOnlyComments = (chunk: string) => /^(--.*\n?)*$/.test(chunk);

const SIDECAR_FILES = [
  "ledger-triggers.sql",
  "payment-legs-triggers.sql",
  "check-constraints.sql",
];

const readSidecar = (name: string) =>
  readFileSync(path.join(process.cwd(), "prisma", "sql", name), "utf8");

describe("sidecar SQL splitter", () => {
  describe.each(SIDECAR_FILES)("%s", (name) => {
    // The upstream trim is what makes the two predicates agree on trailing
    // whitespace, so the oracle has to see the same chunks the filter does.
    const trimmedChunks = readSidecar(name)
      .split(/^--\s*SPLIT\s*$/m)
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    it("decides every chunk exactly as the regex it replaced did", () => {
      expect(trimmedChunks.length).toBeGreaterThan(0);
      for (const chunk of trimmedChunks) {
        expect(isOnlyComments(chunk)).toBe(legacyIsOnlyComments(chunk));
      }
    });

    it("yields the same statements the old pipeline yielded", () => {
      const legacy = trimmedChunks.filter((c) => !legacyIsOnlyComments(c));
      expect(splitSqlStatements(readSidecar(name))).toEqual(legacy);
    });

    it("emits executable SQL, never a bare comment block", () => {
      const statements = splitSqlStatements(readSidecar(name));
      expect(statements.length).toBeGreaterThan(0);
      for (const stmt of statements) {
        expect(stmt).not.toMatch(/^(--[^\n]*\n?)+$/);
      }
    });
  });

  it("keeps the trigger each sidecar exists to create", () => {
    // Guards the split itself: a splitter that dropped the CREATE would still
    // pass the equivalence tests if the oracle were wrong in the same way.
    const byFile = {
      "ledger-triggers.sql": /CREATE CONSTRAINT TRIGGER|CREATE TRIGGER/,
      "payment-legs-triggers.sql":
        /CREATE CONSTRAINT TRIGGER payment_legs_sum_to_amount/,
      "check-constraints.sql": /ADD CONSTRAINT/,
    };
    for (const [name, pattern] of Object.entries(byFile)) {
      const statements = splitSqlStatements(readSidecar(name));
      expect(statements.some((s) => pattern.test(s))).toBe(true);
    }
  });

  describe("isOnlyComments", () => {
    it("drops pure comment blocks and keeps real SQL", () => {
      expect(isOnlyComments("-- a\n-- b")).toBe(true);
      expect(isOnlyComments("CREATE TRIGGER foo ...")).toBe(false);
    });

    it("does not let a leading comment swallow the statement under it", () => {
      expect(isOnlyComments("-- why this exists\nCREATE TRIGGER foo")).toBe(
        false,
      );
    });

    // #1307 review — the first pass used `trimEnd()`, which quietly disagreed
    // with the oracle here. Unreachable via splitSqlStatements, but the
    // predicate is exported, so the contract is the oracle's, not the
    // pipeline's.
    it.each([
      ["the empty string", ""],
      ["a trailing whitespace-only line", "-- a\n \n"],
      ["a whitespace-only line in the middle", "-- a\n \n-- b"],
      ["one trailing newline", "-- a\n"],
      ["two trailing newlines", "-- a\n\n"],
      ["a lone newline", "\n"],
      ["a single space", " "],
    ])("matches the old regex on %s", (_name, input) => {
      expect(isOnlyComments(input)).toBe(legacyIsOnlyComments(input));
    });

    it("treats a blank line between comments as not-all-comments, as the regex did", () => {
      // Matching the old behaviour exactly rather than improving on it: this is
      // a ReDoS fix, not a semantics change. Unreachable in practice — the
      // upstream .trim() only strips the ends, but no real chunk hits it.
      expect(isOnlyComments("-- a\n\n-- b")).toBe(false);
      expect(legacyIsOnlyComments("-- a\n\n-- b")).toBe(false);
    });

    // Differential test against the oracle on inputs chosen to break it. The
    // old regex was flagged S5852 but is not actually catastrophic here — `.`
    // never crosses a newline, so iterations are line-bounded and there is no
    // ambiguous partition to explore. Measured: it never exceeded 1ms on any
    // of these. That is worth pinning, because it is the evidence that the
    // replacement changed the quality gate and nothing else.
    it.each([
      ["20k near-miss lines", "-- x\n".repeat(20_000) + "!"],
      ["300k-char single line", "--" + "a".repeat(300_000)],
      ["long line then a failure", "--" + " a".repeat(100_000) + "\nz"],
      ["alternating blank lines", "-- a\n\n".repeat(20_000) + "!"],
      ["40k lines, all comments", "-- x\n".repeat(40_000)],
    ])("agrees with the old regex on %s", (_name, input) => {
      expect(isOnlyComments(input)).toBe(legacyIsOnlyComments(input));
    });

    it("stays linear on large input", () => {
      // A regression guard, not a ReDoS proof: it fails if someone swaps the
      // line scan back for a quantified-group regex that IS catastrophic.
      const started = Date.now();
      isOnlyComments("-- x\n".repeat(20_000) + "!");
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  });
});
