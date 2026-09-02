-- #1319 — capture two columns that exist in the database but not in
-- prisma/schema.prisma, so the pre-MVP reset's `db push` can drop them without
-- losing whatever they hold. Neither column has a single reference in
-- application code (verified 2026-09-02), so the capture is insurance, not a
-- migration. Run MANUALLY before the reset push; it is idempotent and a no-op
-- on a database that already lacks the columns.
--
-- Applied: not yet (reset runbook step 1, docs/prisma/pre-mvp-reset-runbook.md).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ConsultantReview' AND column_name = 'isAnonymous'
  ) THEN
    EXECUTE 'CREATE TABLE IF NOT EXISTS "_phantom_consultant_review_is_anonymous" AS
             SELECT "id", "isAnonymous" FROM "ConsultantReview" WHERE "isAnonymous" IS NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'AppointmentFeedback' AND column_name = 'slotOfAppointmentId'
  ) THEN
    EXECUTE 'CREATE TABLE IF NOT EXISTS "_phantom_appointment_feedback_slot" AS
             SELECT "id", "slotOfAppointmentId" FROM "AppointmentFeedback" WHERE "slotOfAppointmentId" IS NOT NULL';
  END IF;
END $$;
