-- Booking invariants: occurrence timing, ordinals, the consultant overlap exclusion and append-only history.
BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE "AppointmentOccurrence" DROP CONSTRAINT IF EXISTS "occurrence_time_order";
ALTER TABLE "AppointmentOccurrence" ADD CONSTRAINT "occurrence_time_order" CHECK ("endsAt" > "startsAt");

-- An ordinal is unique among live occurrences; a replaced or voided row keeps its number as history.
DROP INDEX IF EXISTS "appointment_occurrence_live_ordinal_key";
CREATE UNIQUE INDEX IF NOT EXISTS "appointment_occurrence_live_ordinal_key"
  ON "AppointmentOccurrence" ("appointmentId", "ordinal")
  WHERE "completionStatus" NOT IN ('RESCHEDULED', 'CANCELLED', 'VOIDED') AND "deletedAt" IS NULL;

-- Two confirmed, live occurrences of one consultant never overlap; '[)' ranges let sessions touch.
ALTER TABLE "AppointmentOccurrence" DROP CONSTRAINT IF EXISTS "occurrence_no_confirmed_overlap";
ALTER TABLE "AppointmentOccurrence" ADD CONSTRAINT "occurrence_no_confirmed_overlap"
  EXCLUDE USING gist (
    "consultantProfileId" WITH =,
    tstzrange("startsAt", "endsAt") WITH &&
  )
  WHERE ("consultantProfileId" IS NOT NULL AND NOT "isTentative" AND "deletedAt" IS NULL AND "completionStatus" NOT IN ('CANCELLED', 'RESCHEDULED'));

-- A confirmed, live occurrence names its consultant, so the overlap exclusion cannot be bypassed by NULL.
ALTER TABLE "AppointmentOccurrence"
  DROP CONSTRAINT IF EXISTS "occurrence_confirmed_requires_consultant_chk",
  ADD CONSTRAINT "occurrence_confirmed_requires_consultant_chk"
    CHECK (
      "isTentative"
      OR "deletedAt" IS NOT NULL
      OR "consultantProfileId" IS NOT NULL
      OR "completionStatus" IN ('CANCELLED', 'RESCHEDULED')
    ) NOT VALID;
ALTER TABLE "AppointmentOccurrence"
  VALIDATE CONSTRAINT "occurrence_confirmed_requires_consultant_chk";

-- Booking history is append-only except retention deletes of rows older than three years.
DROP TRIGGER IF EXISTS booking_status_history_immutable ON "BookingStatusHistory";

CREATE OR REPLACE FUNCTION assert_booking_status_history_immutable() RETURNS trigger
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."createdAt" < now() - interval '3 years' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'BookingStatusHistory % is immutable (% refused)', OLD."id", TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER booking_status_history_immutable
  BEFORE UPDATE OF "id", "entity", "entityId", "fromStatus", "toStatus", "reason", "createdAt"
  OR DELETE ON "BookingStatusHistory"
  FOR EACH ROW
  EXECUTE FUNCTION assert_booking_status_history_immutable();

-- An appointment's single parent matches its type; TRIAL rows have none; a new type fails until listed.
ALTER TABLE "Appointment" DROP CONSTRAINT IF EXISTS "appointment_parent_matches_type";
ALTER TABLE "Appointment" ADD CONSTRAINT "appointment_parent_matches_type"
  CHECK (CASE "appointmentType"
    WHEN 'CONSULTATION' THEN "consultationId" IS NOT NULL AND num_nonnulls("subscriptionId","webinarId","classId") = 0
    WHEN 'SUBSCRIPTION' THEN "subscriptionId" IS NOT NULL AND num_nonnulls("consultationId","webinarId","classId") = 0
    WHEN 'WEBINAR'      THEN "webinarId" IS NOT NULL      AND num_nonnulls("consultationId","subscriptionId","classId") = 0
    WHEN 'CLASS'        THEN "classId" IS NOT NULL        AND num_nonnulls("consultationId","subscriptionId","webinarId") = 0
    WHEN 'TRIAL'        THEN num_nonnulls("consultationId","subscriptionId","webinarId","classId") = 0
    ELSE FALSE END);

-- A declared platform incident is a real window.
ALTER TABLE "PlatformIncident" DROP CONSTRAINT IF EXISTS "platform_incident_time_order";
ALTER TABLE "PlatformIncident" ADD CONSTRAINT "platform_incident_time_order"
  CHECK ("endsAt" > "startsAt");

COMMIT;
