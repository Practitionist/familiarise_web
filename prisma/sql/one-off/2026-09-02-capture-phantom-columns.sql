-- #1319 — capture two columns that exist in the database but not in
-- prisma/schema.prisma, so the pre-MVP reset's `db push` can drop them without
-- losing whatever they hold. Neither column has a single reference in
-- application code (verified 2026-09-02), so the capture is insurance, not a
-- migration. Run MANUALLY before the reset push; it is re-runnable (each run
-- replaces the capture with the current values, so an earlier capture can never
-- shadow a later edit) and a no-op on a database that already lacks the columns.
--
-- SUPERSEDED 2026-09-03: `prisma db push` drops tables the schema does not know,
-- so these capture tables are removed by the push they precede. The runbook now
-- captures to CSV files with `\copy` instead; this file is kept as history.
-- Applied once on 2026-09-03 and dropped by the same day's push (rows recovered
-- from the pre-push pg_dump).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ConsultantReview' AND column_name = 'isAnonymous'
  ) THEN
    EXECUTE 'DROP TABLE IF EXISTS "_phantom_consultant_review_is_anonymous"';
    EXECUTE 'CREATE TABLE "_phantom_consultant_review_is_anonymous" AS
             SELECT "id", "isAnonymous" FROM "ConsultantReview" WHERE "isAnonymous" IS NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'AppointmentFeedback' AND column_name = 'slotOfAppointmentId'
  ) THEN
    EXECUTE 'DROP TABLE IF EXISTS "_phantom_appointment_feedback_slot"';
    EXECUTE 'CREATE TABLE "_phantom_appointment_feedback_slot" AS
             SELECT "id", "slotOfAppointmentId" FROM "AppointmentFeedback" WHERE "slotOfAppointmentId" IS NOT NULL';
  END IF;
END $$;
