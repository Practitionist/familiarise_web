# 09-g · Integrity: maintenance freeze (owner drills)

**Needs:** a **production** maintenance window run by the owner. Maintenance changes are refused on every other deploy (`409 MAINTENANCE_PRODUCTION_ONLY`, "Maintenance changes run only on the production deploy."), because the window, its Redis mirror and the drains are shared. This suite never runs against production, so every case here is **NEEDS-OWNER-RUN**: the runner prepares QA fixtures and the verification SQL; the owner flips the phase during a planned window; the runner verifies afterwards. CC-64 checks the refusal on a preview.
**Personas:** B1, H1, AD (owner's admin account for the flip).
**Docs under test:** `lib/maintenance-cron.ts`, `lib/cron/financial-jobs.ts`, `middleware.ts` (maintenance gate), `docs/maintenance/07-post-maintenance-recovery.md` §4, `docs/maintenance/04-cron-jobs-reference.md`.

Salvaged from old 008. What the code does: phases `OFF → DEGRADED → OFFLINE`. DEGRADED blocks write APIs at the middleware (`503`, body `{ error: "Writes are temporarily unavailable during maintenance", phase: "DEGRADED", reason, estimatedEnd }`, `Retry-After` when an end is set); OFFLINE blocks all non-exempt routes (`503` on `/api/*`, the `/maintenance` page elsewhere). Financial jobs (`FINANCIAL_JOB_NAMES`: `cleanup-abandoned-payments`, `reconcile-pending-refunds`, `release-earnings`, `expire-stale-requests`, `expire-unpaid-trials`, `settle-cancelled-sessions`, `retry-auto-refunds`, `detect-consultant-no-shows`, `sync-payment-earnings`, payouts and others) refuse under any blocking phase; non-financial booking jobs (`auto-complete-appointments`, `expire-reschedule-proposals`, `cleanup-tentative-occurrences`, `send-appointment-reminders`) keep running in DEGRADED. An unreadable phase fails closed (`503` `MAINTENANCE_STATE_UNREADABLE`).

## CC-67 — What users see while writes are frozen

**Why it matters:** a frozen app that looks broken generates panic and duplicate attempts.

**Setup:** a live QA booking for B1 (paid, ≥ 48 h out) and a pending H1 request.

**Steps (during the owner's DEGRADED window):** as B1 open the booking, try Cancel and Reschedule, try a new checkout; as H1 try Approve and Save on allocate. Record each response and the banner.

**Expect:** reads work; every write answers `503` with `phase: "DEGRADED"` and the reason; the UI shows a maintenance banner and a human message on each refused action ("try again after …" with the estimated end in the viewer's zone), not "Something went wrong". No partial writes (R-03 unchanged).

**Probe further:** does any button stay enabled and spin forever? Does the checkout tell B1 their card was not charged?

## CC-68 — A checkout in flight survives the freeze

**Why it matters:** the abandoned sweep must not destroy a payment mid-freeze, and the row must never vanish.

**Setup (before the window):** a QA checkout left `PENDING` with `expiresAt` 30 min ahead (MO-02 shape). Record payment and occurrence ids.

**Steps:** owner enters DEGRADED; owner triggers `abandoned-payments` (it should refuse with "Maintenance mode is DEGRADED — cleanup-abandoned-payments is a financial job and is unavailable until maintenance ends"); owner ends maintenance after `expiresAt` passes; owner runs `abandoned-payments` again.

**Expect:** during the freeze: the job refuses (SystemJobExecution row with the maintenance refusal; record its status); payment still `PENDING`; occurrence count unchanged. After thaw: payment `EXPIRED` by status transition, the row and its `appointmentId` link intact; only the tentative hold released.

```sql
SELECT id, "paymentStatus", "appointmentId", "expiresAt" FROM "Payment" WHERE id = :pid;
SELECT count(*) FROM "AppointmentOccurrence" WHERE "appointmentId" = :aid AND "deletedAt" IS NULL;
SELECT "jobName", status, "startedAt", "errorLog" FROM "SystemJobExecution" WHERE "jobName" = 'cleanup-abandoned-payments' ORDER BY "startedAt" DESC LIMIT 3;
```

## CC-69 — A cancel after the thaw refunds once, whatever re-drives follow

**Why it matters:** the post-maintenance catch-up runs every refund re-drive; none may pay twice.

**Setup:** a fresh mock-paid QA booking (local, before the window is irrelevant: the booking just needs to exist and be ≥ 24 h out).

**Steps:** during DEGRADED, B1's cancel is refused (`503`). After thaw, B1 cancels (100 %). Then immediately: B1 cancels again; owner runs `reconcile-refunds`, `retry-auto-refunds`, `sync-payment-earnings` (the recovery doc's catch-up list).

**Expect:**

```sql
SELECT count(*) AS refunds, coalesce(sum("amountPaise"), 0) AS refunded FROM "Refund" WHERE "paymentId" = :pid;   -- 1, = amount
SELECT status, "cascadedAt" FROM "Refund" WHERE "paymentId" = :pid;                                             -- cascadedAt set, unchanged across re-drives
SELECT "refundedShareAmount", "consultantSharePaise" FROM "ConsultantEarnings" WHERE "paymentId" = :pid;         -- equal, once
SELECT count(*) FROM "LedgerTransaction" t JOIN "Refund" r ON t."idempotencyKey" = 'refund:' || r."refundId" WHERE r."paymentId" = :pid; -- 1
```

The second cancel answers `200` with `replayed: true` (CC-33). Any second refund, doubled clawback or second journal is P0.

## CC-70 — A freeze that lands between the cancel and the refund

**Why it matters:** the marker must carry the obligation across the freeze.

**Setup:** a real-gateway QA booking (refund settles asynchronously), or the MO-56 QA-ONLY emulation of a marker stamped just before the freeze.

**Steps:** cancel (or stamp) just before the owner enters DEGRADED; owner runs `retry-auto-refunds` during the freeze (refused: financial job); owner ends maintenance; owner runs it again.

**Expect:** during the freeze: marker set, no refund driven. After thaw: one `Refund` under the marker's key, marker cleared; the same four checks as CC-69.

**Probe further:** what did B1 see during the freeze: "refund pending" (true) or "refunded" (false)?
