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

describe("occurrence_no_confirmed_overlap tombstone exemption (#1694 / #2010)", () => {
  it("exempts soft-deleted and cancelled/rescheduled rows in the sidecar exclusion constraint", () => {
    const sql = read("prisma/sql/check-constraints.sql");
    const sidecar = constraintPredicate(sql);
    expect(sidecar).toContain('"consultantProfileId" IS NOT NULL');
    expect(sidecar).toContain('NOT "isTentative"');
    expect(sidecar).toContain('"deletedAt" IS NULL');
    expect(sidecar).toContain(
      "\"completionStatus\" NOT IN ('CANCELLED', 'RESCHEDULED')",
    );
  });

  it("enforces non-null consultantProfileId on confirmed, non-deleted occurrences (#2010)", () => {
    const sql = read("prisma/sql/check-constraints.sql");
    expect(sql).toMatch(
      /ADD CONSTRAINT "occurrence_confirmed_requires_consultant_chk"\s+CHECK \("isTentative" OR "deletedAt" IS NOT NULL OR "consultantProfileId" IS NOT NULL\);/,
    );
  });
});

