/**
 * #1694 — the exclusion constraint must exempt tombstones. A cancel keeps the
 * occurrence row (CANCELLED + deletedAt, isTentative untouched) and every
 * reader paints the time free, so a predicate without the `deletedAt` arm made
 * re-booking a cancelled time 409 at commit. The sidecar is the schema here,
 * and the live-swap script must build the identical predicate.
 */
import { readSidecarMigrationSql } from "../../scripts/db/sidecar-objects";

const constraintPredicate = (sql: string): string => {
  const match =
    /ADD CONSTRAINT "occurrence_no_confirmed_overlap"[\s\S]*?WHERE\s*(\([^;]*\))\s*;/.exec(
      sql,
    );
  if (!match)
    throw new Error("exclusion constraint not found in the migrations");
  return match[1].replace(/\s+/g, " ");
};

describe("occurrence_no_confirmed_overlap tombstone exemption (#1694 / #2010)", () => {
  it("exempts soft-deleted and cancelled/rescheduled rows in the migration exclusion constraint", () => {
    const sql = readSidecarMigrationSql();
    const sidecar = constraintPredicate(sql);
    expect(sidecar).toContain('"consultantProfileId" IS NOT NULL');
    expect(sidecar).toContain('NOT "isTentative"');
    expect(sidecar).toContain('"deletedAt" IS NULL');
    expect(sidecar).toContain(
      "\"completionStatus\" NOT IN ('CANCELLED', 'RESCHEDULED')",
    );
  });

  it("enforces non-null consultantProfileId on confirmed, non-deleted, non-cancelled occurrences (#2010)", () => {
    const sql = readSidecarMigrationSql();
    expect(sql).toMatch(
      /ADD CONSTRAINT "occurrence_confirmed_requires_consultant_chk"\s+CHECK \(\s*"isTentative"\s+OR "deletedAt" IS NOT NULL\s+OR "consultantProfileId" IS NOT NULL\s+OR "completionStatus" IN \('CANCELLED', 'RESCHEDULED'\)\s*\) NOT VALID;/,
    );
    expect(sql).toMatch(
      /VALIDATE CONSTRAINT "occurrence_confirmed_requires_consultant_chk";/,
    );
  });
});
