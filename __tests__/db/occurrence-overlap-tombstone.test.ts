/**
 * #1694 — the exclusion constraint must exempt tombstones. A cancel keeps the
 * occurrence row (CANCELLED + deletedAt, isTentative untouched) and every
 * reader paints the time free, so a predicate without the `deletedAt` arm made
 * re-booking a cancelled time 409 at commit. The sidecar is the schema here,
 * and the live-swap script must build the identical predicate.
 */
import { readFileSync } from "fs";
import path from "path";

const read = (rel: string) =>
  readFileSync(path.join(process.cwd(), rel), "utf8");

const constraintPredicate = (sql: string): string => {
  const match =
    /ADD CONSTRAINT "occurrence_no_confirmed_overlap"[\s\S]*?WHERE\s*(\([^;]*\))\s*;/.exec(
      sql,
    );
  if (!match) throw new Error("exclusion constraint not found in sidecar");
  return match[1].replace(/\s+/g, " ");
};

describe("occurrence_no_confirmed_overlap tombstone exemption (#1694)", () => {
  it("exempts soft-deleted rows, and the swap script builds the same predicate", () => {
    const sidecar = constraintPredicate(
      read("prisma/sql/check-constraints.sql"),
    );
    expect(sidecar).toContain('"consultantProfileId" IS NOT NULL');
    expect(sidecar).toContain('NOT "isTentative"');
    expect(sidecar).toContain('"deletedAt" IS NULL');

    const script = read("scripts/db/swap-occurrence-overlap-constraint.ts");
    const declared = /NEW_PREDICATE =\s*'([^']+)'/.exec(script)?.[1];
    expect(declared?.replace(/\s+/g, " ")).toBe(sidecar);
  });
});
