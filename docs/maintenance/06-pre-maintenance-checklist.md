# Pre-maintenance checklist

1. Choose a reason and explicit phase. Cosmetic changes generally do not need maintenance. Use DEGRADED for work that permits reads; use OFFLINE for work that can invalidate database reads or active sessions.
2. Open the ADMIN Maintenance page and run its preflight check. Review active calls, pending payments/payouts, upcoming appointments and dispute response deadlines. An override of the dispute warning is an explicit operator decision, not the default.
3. Verify the current host, database target, recent backup, deployment SHA and rollback procedure. Keep standby Netlify code/config intact. Do not run `db push` or sidecar commands merely to inspect drift.
4. Inform affected users and choose an ETA. The ETA does not automatically reopen traffic. Keep credentials and bypass tokens private.
5. Start the chosen phase with a reason of at least five characters. OFFLINE pauses discount codes and drains Stream sessions; inspect errors before beginning schema work. Use Retry Offline Setup until the response has no drain/channel errors or remaining backlog. Each request handles at most 200 active meetings and 200 channel operations; acknowledged channel freezes survive retries. Repeating activation preserves the original discount snapshot.
6. Verify both ordinary access and authorized bypass. Confirm the public maintenance page/banner and denied money writes. Inspect active `SystemJobExecution` leases and wait for already-running requests/jobs to settle; an entry-time gate cannot stop work already in progress.
7. If bookings require cancellation, preview an explicit interval in Booking remediation, inspect the whole-booking scope and selected IDs, and confirm separately. No bookings are cancelled merely by selecting OFFLINE. Confirmed requests queue durably and run after maintenance ends.
8. Apply only the reviewed deployment/database procedure. Sidecar replacement uses one transaction per file with a three-second lock timeout; a blocked or failed replacement must roll back rather than leave a DROP committed alone. Run dry-run and isolated tests before any approved production apply.
9. Keep an operator available until explicit recovery succeeds. If the ETA passes, update it or continue maintenance; do not depend on expiry.

## Bounded booking remediation capacity

The automatic whole-booking cancellation path currently supports at most eight live participants, twelve non-tentative undeleted occurrences, ten payment rows and ten notification recipients per booking. These conservative execution guards are not offering-plan limits or measured throughput guarantees. Preview, confirmation and worker execution recheck capacity; cap-plus-one reads reject growth instead of truncating refund or notification obligations.

Larger bookings remain unsupported by this maintenance action and require a separately reviewed cancellation procedure. No ready large-roster procedure is implied. An oversized queued booking remains pending with a visible error while other items can rotate; it must not be marked completed, partially cancelled or silently dropped. Verify supported-size execution against the deployed runtime before using this action operationally.

## Deprecated & Superseded Approaches

The maintenance toggle previously guessed a booking cancellation interval and automatically ran refunds. A planned ETA also acted as a state-expiry deadline. The current flow separates communication, access control and explicitly confirmed booking remediation.
