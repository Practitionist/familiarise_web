-- Job locks, admin run requests and the outbox scan indexes.
BEGIN;
SET LOCAL lock_timeout = '3s';

-- At most one RUNNING execution per job, so two tickers cannot both take the cron lock.
CREATE UNIQUE INDEX IF NOT EXISTS "SystemJobExecution_running_jobName_key"
  ON "SystemJobExecution" ("jobName")
  WHERE "status" = 'RUNNING';

-- Partial indexes backing active outbox relay scans and the 7-day SENT body scrub sweep.
CREATE INDEX IF NOT EXISTS "FailedEmail_active_outbox_idx"
  ON "FailedEmail" ("nextRetryAt" ASC NULLS FIRST)
  WHERE "status" IN ('PENDING', 'RETRY');

CREATE INDEX IF NOT EXISTS "FailedEmail_sent_unscrubbed_updatedAt_idx"
  ON "FailedEmail" ("updatedAt")
  WHERE "status" = 'SENT' AND ("htmlBody" <> '' OR "textBody" IS NOT NULL);

CREATE INDEX IF NOT EXISTS "FailedEmailBatch_active_outbox_idx"
  ON "FailedEmailBatch" ("nextRetryAt" ASC NULLS FIRST)
  WHERE "status" IN ('PENDING', 'RETRY');

CREATE INDEX IF NOT EXISTS "NotificationOutbox_active_outbox_idx"
  ON "NotificationOutbox" ("nextRetryAt" ASC NULLS FIRST, "notBefore")
  WHERE "status" IN ('PENDING', 'RETRY');

-- One open admin run request per job; a settled request frees the job for the next one.
CREATE UNIQUE INDEX IF NOT EXISTS "admin_run_request_one_open_key"
  ON "AdminRunRequest" ("job")
  WHERE "status" IN ('REQUESTED', 'CLAIMED');

-- A claimed request carries its claim time and a settled one its finish time.
ALTER TABLE "AdminRunRequest" DROP CONSTRAINT IF EXISTS "admin_run_request_state";
ALTER TABLE "AdminRunRequest" ADD CONSTRAINT "admin_run_request_state"
  CHECK ("attempts" >= 0
    AND ("status" <> 'CLAIMED' OR "claimedAt" IS NOT NULL)
    AND ("status" NOT IN ('DONE', 'FAILED') OR "finishedAt" IS NOT NULL));

COMMIT;
