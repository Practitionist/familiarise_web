-- Read-only analytics views. One source for "who wants what", with no user ids
-- or emails. A view pins the columns it reads: a push that retypes one of them
-- (an enum value removed, say) fails until `DROP VIEW "demand"`, and
-- `npm run db:sidecars` recreates it.
--
-- demand: one row per interest row across the appointment waitlist (EVENT) and
-- slot backup interest (WINDOW). An event's host is its plan's consultant.
CREATE OR REPLACE VIEW "demand" WITH (security_invoker = true) AS
SELECT
  'EVENT'::text AS "kind",
  w."planKind",
  w."planId",
  COALESCE(wp."consultantProfileId", cp."consultantProfileId") AS "consultantProfileId",
  w."status",
  w."createdAt",
  w."notifiedAt",
  w."bookedAt"
FROM "AppointmentWaitlist" w
LEFT JOIN "WebinarPlan" wp ON w."planKind" = 'WEBINAR' AND wp."id" = w."planId"
LEFT JOIN "ClassPlan" cp ON w."planKind" = 'CLASS' AND cp."id" = w."planId"
UNION ALL
SELECT
  'WINDOW'::text,
  b."planKind",
  b."planId",
  b."consultantProfileId",
  b."status",
  b."createdAt",
  b."notifiedAt",
  b."bookedAt"
FROM "WindowBackupInterest" b;
-- SPLIT
-- The app reads through the owner role only; keep the view off the Data API.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "demand" FROM anon, authenticated;
  END IF;
END $$;
