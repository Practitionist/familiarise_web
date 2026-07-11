# Audit Logs & Compliance Ops

## Context

`OrgAuditLog` with categories and sanitization; CSV export; retention prune (7y financial-ish, 2y operational). Ledger + TDSRecord as financial audit. Webhook scrubber for PII. Compliance jobs: IRP, MSME alerts, breach deadlines, consent sweeper, data exports, audit prune.

## Known gaps / bugs

- No platform-wide B2C user audit log — org-scoped emphasis.
- Supabase `audit_logs` historical dead end (removed triggers).
- Missing planned jobs: grievance SLA sweeper, GST TCS aggregator, TDS quarterly prep, erasure SLA cron.
- SOC 2 / ISO evidence automation deferred.
- Cron Slack alerts need `SLACK_OPS_WEBHOOK_URL`.

## Unhappy paths & user psychology

- Enterprise security questionnaire asks for immutable admin audit of B2C staff actions — thin answer today.
- Breach table updated late; 72h alert fires after customer already tweeted.

## Questions (handled?)

1. **Platform audit log for ADMIN/STAFF on consumer data?**  
   - A) Build now  
   - B) Org-only until SOC 2  
   - C) Rely on provider logs (BetterAuth, Sentry)  

2. **Page on-call for compliance cron failures?**  
   - A) PagerDuty  
   - B) Slack only  
   - C) Weekly human checklist  

3. **Erasure SLA automation?**  
   - A) Cron escalating overdue ErasureRequest  
   - B) Admin calendar reminder  
   - C) Legal holds queue first  

## High concurrency / multi-device

Audit write volume under webhook storms — ensure async/non-blocking. Export jobs must not lock hot tables during business hours.

## Suggested directions

Wire Slack ops webhook. Add erasure SLA sweeper. Decide platform audit scope before enterprise security reviews.
