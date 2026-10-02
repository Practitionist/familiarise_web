-- ============================================================================
-- Partial Unique Indexes (prisma/sql/partial-indexes.sql)
-- ============================================================================
-- Prisma schema syntax does not declare partial (`WHERE ...`) unique indexes
-- as engine-enforced constraints without raw SQL sidecars.
--
-- #1915 / #1926 — Enforce at the Postgres engine level that at most one
-- `SystemJobExecution` row per `jobName` can hold `status = 'RUNNING'` at any
-- instant. Concurrent cron invocations racing past `findFirst` collide with
-- SQLSTATE 23505 (Prisma P2002) on `SystemJobExecution.create`, which
-- `withCronLock` converts into `CronLockHeldError(jobName)`.
CREATE UNIQUE INDEX IF NOT EXISTS "SystemJobExecution_running_jobName_key"
  ON "SystemJobExecution" ("jobName")
  WHERE "status" = 'RUNNING';
