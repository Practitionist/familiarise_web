# SQL recipes (Supabase MCP `execute_sql`)

Prisma maps models to quoted PascalCase tables and camelCase columns, so always quote: `"Appointment"."consultationId"`. Money columns are **paise** (`BigInt`); divide by 100 in your prose. Times are UTC (`timestamptz`). Replace `:placeholders` with literal values.

Reads are free. Writes raise the owner-approval prompt: batch them, wrap them in `BEGIN; … COMMIT;`, and add `RETURNING` so ids go into your ledger.

## R-01 Persona ids (run first)

```sql
SELECT u.email, u.id AS "userId", u.timezone, u.role,
       cp.id AS "consultantProfileId", cp."scheduleType", cp."isIndependent",
       ce.id AS "consulteeProfileId", sp.id AS "staffProfileId",
       (SELECT json_agg(json_build_object('org', m."organizationId", 'role', m.role, 'status', m.status))
          FROM "Membership" m WHERE m."userId" = u.id) AS memberships
FROM "User" u
LEFT JOIN "ConsultantProfile" cp ON cp."userId" = u.id
LEFT JOIN "ConsulteeProfile" ce ON ce."userId" = u.id
LEFT JOIN "StaffProfile" sp ON sp."userId" = u.id
WHERE u.email IN ('hannah.anderson@yahoo.com','grace.anderson@outlook.com','james.anderson@protonmail.com',
  'ethan.anderson@gmail.com','charlotte.brown@protonmail.com','daniel.brown@gmail.com','david.brown@outlook.com',
  'patrick.anderson@outlook.com','olivia.anderson@gmail.com','samantha.anderson@yahoo.com',
  'daniel.anderson@outlook.com','aarav.anderson@gmail.com','qa-staff-1@qa.familiarise.invalid',
  'qa-admin-2@qa.familiarise.invalid');
```

## R-02 Availability and plans for a host

```sql
SELECT "localStartDay","localStartMinutes","localEndDay","localEndMinutes",timezone,
       "startDay","startTimeUtc","endDay","endTimeUtc","utcOffsetMinutes"
FROM "AvailabilityWindowWeekly" WHERE "consultantProfileId" = :cid ORDER BY "startDay","startTimeUtc";

SELECT 'sub' k, id, title, status, "sessionsPerWeek", "sessionDurationInHours", "durationInWeeks",
       "durationInMonths", "totalSessions", "trialEnabled", "trialDurationMinutes", "trialPriceInPaise", price
FROM "SubscriptionPlan" WHERE "consultantProfileId" = :cid AND "archivedAt" IS NULL
UNION ALL
SELECT 'class', id, title, status::text, "sessionsPerWeek", "sessionDurationInHours", NULL, "durationInMonths",
       "totalSessions", NULL, NULL, NULL, price
FROM "ClassPlan" WHERE "consultantProfileId" = :cid AND "archivedAt" IS NULL;
```

## R-03 Full booking graph for one appointment

```sql
SELECT a.id, a."appointmentType", a."deletedAt",
       c.status AS consult, s.status AS sub, w.status AS webinar, k.status AS class, t.status AS trial
FROM "Appointment" a
LEFT JOIN "Consultation" c ON c.id = a."consultationId"
LEFT JOIN "Subscription" s ON s.id = a."subscriptionId"
LEFT JOIN "Webinar" w ON w.id = a."webinarId"
LEFT JOIN "Class" k ON k.id = a."classId"
LEFT JOIN "Trial" t ON t."appointmentId" = a.id
WHERE a.id = :aid;

SELECT id, ordinal, "startsAt", "endsAt", "isTentative", "completionStatus", "deletedAt", "movedAt",
       "hostCancelledAt", "voidedAt", "consultantProfileId"
FROM "AppointmentOccurrence" WHERE "appointmentId" = :aid ORDER BY ordinal, "startsAt";

SELECT p.id, u.email, p.role, p.status, p."paymentId", p."sessionsPurchased", p."organizationId"
FROM "AppointmentParticipant" p JOIN "User" u ON u.id = p."userId" WHERE p."appointmentId" = :aid;

SELECT entity, "fromStatus", "toStatus", reason, "actorUserId", "createdAt"
FROM "BookingStatusHistory" WHERE "appointmentId" = :aid ORDER BY "createdAt";

SELECT id, status, "initiatorRole", round, "expiresAt", "originStatus", "releasedSessions",
       "releasedOccurrenceIds", "restoredAt", "openForAppointmentId", "resolvedAt"
FROM "RescheduleRequest" WHERE "appointmentId" = :aid ORDER BY "createdAt";
```

## R-04 Money for one appointment

```sql
SELECT id, amount, "originalAmount", "taxAmount", "paymentStatus", "isMockPayment", "expiresAt", "capturedAt",
       "refundOwedKey", "refundOwedPaise", "refundOwedReason", "refundOwedAttempts", description, "organizationId"
FROM "Payment" WHERE "appointmentId" = :aid ORDER BY "createdAt";

SELECT r.id, r."paymentId", r."amountPaise", r.status, r.reason, r."dedupeKey", r."failureReason", r."createdAt"
FROM "Refund" r JOIN "Payment" p ON p.id = r."paymentId" WHERE p."appointmentId" = :aid;

SELECT e.id, e.role, e.status, e."grossAmount", e."platformFeePaise", e."consultantSharePaise",
       e."refundedShareAmount", e."holdUntil", e."appointmentOccurrenceId",
       (SELECT json_agg(json_build_object('reason', h.reason, 'released', h."releasedAt"))
          FROM "EarningsHold" h WHERE h."consultantEarningsId" = e.id) AS holds
FROM "ConsultantEarnings" e JOIN "Payment" p ON p.id = e."paymentId" WHERE p."appointmentId" = :aid;
```

**Money invariants to check after every refund:** sum of `Refund."amountPaise"` (status `SUCCEEDED` or `PENDING`) ≤ `Payment.amount`; one refund per `dedupeKey`; `refundedShareAmount` moved in proportion; no refund on a free (amount 0) payment; a `refundOwedKey` (`class-end:…`, `trial-cancel:…`, `plan-end:…`) is cleared once the refund lands.

## R-05 Overlap invariant (one host never double-booked)

Run after every booking, move, race and sweep case. Expect **zero rows**.

```sql
SELECT a.id AS occ_a, b.id AS occ_b, a."startsAt", a."endsAt", b."startsAt", b."endsAt"
FROM "AppointmentOccurrence" a
JOIN "AppointmentOccurrence" b
  ON a."consultantProfileId" = b."consultantProfileId" AND a.id < b.id
 AND a."startsAt" < b."endsAt" AND b."startsAt" < a."endsAt"
WHERE a."consultantProfileId" = :cid
  AND a."deletedAt" IS NULL AND b."deletedAt" IS NULL
  AND a."completionStatus" NOT IN ('CANCELLED','RESCHEDULED','VOIDED')
  AND b."completionStatus" NOT IN ('CANCELLED','RESCHEDULED','VOIDED');
```

## R-06 Plan math for a subscription or class

```sql
SELECT s.id, s.status, s."sessionsTotal", s."sessionsPerWeek", s."sessionMinutes", s."sessionsReturned",
       s."sessionsRefunded", s."schedulingPeriodStartsAt", s."schedulingPeriodEndsAt", s."planEndsAt",
       s."schedulingTimezone",
       (SELECT count(*) FROM "AppointmentOccurrence" o JOIN "Appointment" a ON a.id = o."appointmentId"
         WHERE a."subscriptionId" = s.id AND o."deletedAt" IS NULL
           AND o."completionStatus" NOT IN ('CANCELLED','RESCHEDULED','VOIDED')) AS live_sessions
FROM "Subscription" s WHERE s.id = :sid;

-- sessions per plan week (week = 7-day buckets from schedulingPeriodStartsAt, in schedulingTimezone)
SELECT floor(extract(epoch FROM (o."startsAt" - s."schedulingPeriodStartsAt")) / 604800)::int + 1 AS plan_week,
       count(*) AS sessions
FROM "AppointmentOccurrence" o JOIN "Appointment" a ON a.id = o."appointmentId"
JOIN "Subscription" s ON s.id = a."subscriptionId"
WHERE s.id = :sid AND o."deletedAt" IS NULL AND o."completionStatus" NOT IN ('CANCELLED','RESCHEDULED','VOIDED')
GROUP BY 1 ORDER BY 1;
```

Expect: `live_sessions + sessionsReturned + sessionsRefunded ≤ sessionsTotal`; no plan week above `sessionsPerWeek`; no session after `planEndsAt`.

## R-07 Idempotency and notifications

```sql
SELECT scope, key, "responseStatus", "completedAt", "createdAt", "expiresAt"
FROM "IdempotencyRecord" WHERE "userId" = :uid ORDER BY "createdAt" DESC LIMIT 10;

SELECT kind, status, recipients, "entityRef", "notBefore", "sentAt", "lastError", "createdAt"
FROM "NotificationOutbox" WHERE "entityRef" LIKE '%' || :entityId || '%' ORDER BY "createdAt";
```

## R-08 Find your fixtures

```sql
SELECT 'consultation' k, id, status::text, "requestNotes" FROM "Consultation" WHERE "requestNotes" LIKE 'qa-%'
UNION ALL SELECT 'subscription', id, status::text, "requestNotes" FROM "Subscription" WHERE "requestNotes" LIKE 'qa-%'
UNION ALL SELECT 'trial', id, status::text, notes FROM "Trial" WHERE notes LIKE 'qa-%'
UNION ALL SELECT 'reschedule', id, status::text, reason FROM "RescheduleRequest" WHERE reason LIKE 'qa-%';
```

## R-09 Cleanup (owner approval; children first)

Only for rows in your ledger. Prefer cancelling through the product first.

```sql
BEGIN;
DELETE FROM "AppointmentParticipant" WHERE "appointmentId" = :aid;
DELETE FROM "AppointmentOccurrence" WHERE "appointmentId" = :aid;  -- fails if a meeting/attendance row points at it; delete those first
DELETE FROM "RescheduleRequest" WHERE "appointmentId" = :aid;
DELETE FROM "BookingStatusHistory" WHERE "appointmentId" = :aid;
DELETE FROM "ConsultantEarnings" WHERE "paymentId" IN (SELECT id FROM "Payment" WHERE "appointmentId" = :aid AND "isMockPayment");
DELETE FROM "Refund" WHERE "paymentId" IN (SELECT id FROM "Payment" WHERE "appointmentId" = :aid AND "isMockPayment");
DELETE FROM "Payment" WHERE "appointmentId" = :aid AND "isMockPayment";
DELETE FROM "Appointment" WHERE id = :aid RETURNING id;
COMMIT;
```

If any statement fails on a foreign key, `ROLLBACK`, list the blocking table in your report, and leave the rows. Never delete a non-mock `Payment`.
