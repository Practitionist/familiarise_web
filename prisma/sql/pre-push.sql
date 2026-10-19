-- Renames that must land BEFORE `prisma db push`, which would otherwise drop
-- the old column and add the new one empty. `db:push:schema` runs this file
-- first via `npm run db:pre-push`; every statement is idempotent.

-- The earning's prior-status column, renamed in place for the EarningsHold model.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ConsultantEarnings' AND column_name = 'preDisputeStatus'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ConsultantEarnings' AND column_name = 'preHoldStatus'
  ) THEN
    ALTER TABLE "ConsultantEarnings" RENAME COLUMN "preDisputeStatus" TO "preHoldStatus";
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'OrganizationEarnings' AND column_name = 'preDisputeStatus'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'OrganizationEarnings' AND column_name = 'preHoldStatus'
  ) THEN
    ALTER TABLE "OrganizationEarnings" RENAME COLUMN "preDisputeStatus" TO "preHoldStatus";
  END IF;
END $$;
