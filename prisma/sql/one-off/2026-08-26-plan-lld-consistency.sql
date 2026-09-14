-- Plan authoring consistency pass (plans LLD, 2026-08-26).
--
-- ONE-OFF, in the style of the other files here: schema.prisma is the source
-- of truth and `prisma db push` builds fresh databases correctly on its own.
-- Only already-provisioned databases need this DDL to catch up. Every
-- statement below is idempotent-safe against an already-corrected database
-- EXCEPT the SET NOT NULL / SET DEFAULT pair, which are no-ops when the state
-- already matches (Postgres re-validates but changes nothing).
--
-- Changes, mirroring schema.prisma exactly:
--   1. WebinarPlan.language / CohortPlan.language : nullable → NOT NULL with
--      existing 'English' default. Legacy NULL rows are backfilled first,
--      otherwise the SET NOT NULL would fail.
--   2. CohortPlan.maxParticipants default 1 → 30 (parity with WebinarPlan's
--      usable floor; a 1-participant cohort was never a real offering).
--   3. CohortPlan.description drops NOT NULL (DB relaxed; CohortPlanSchema now
--      enforces "Description is required" at the validation edge instead).
--
-- Physical names verified against the models as declared (no @@map): tables
-- "WebinarPlan" / "CohortPlan", columns named as in Prisma.

-- 1a. Backfill before the NOT NULL flip.
UPDATE "WebinarPlan" SET "language" = 'English' WHERE "language" IS NULL;
UPDATE "CohortPlan"   SET "language" = 'English' WHERE "language" IS NULL;

-- 1b. Language becomes required at the storage layer too.
ALTER TABLE "WebinarPlan" ALTER COLUMN "language" SET NOT NULL;
ALTER TABLE "CohortPlan"   ALTER COLUMN "language" SET NOT NULL;

-- 2. New cohorts default to a real group size.
ALTER TABLE "CohortPlan" ALTER COLUMN "maxParticipants" SET DEFAULT 30;

-- 3. Description relaxed in storage; Zod owns the requirement now.
ALTER TABLE "CohortPlan" ALTER COLUMN "description" DROP NOT NULL;
