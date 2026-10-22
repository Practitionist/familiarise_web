# Post-maintenance recovery

Use the ADMIN Maintenance page to end the window with a recovery audit reason (5–1000 characters). DELETE checks database/Redis health, restores non-expired discount codes from the original snapshot, and unfreezes group channels before publishing OFF. Review the response: errors or a channel backlog leave maintenance active so recovery can be retried. Each request handles at most 200 channel operations, recording `Meeting.maintenanceChannelRecoveredAt` and clearing its freeze stamp only after Stream acknowledges unfreeze. Recovery selects the exact maintenance window and includes meetings whose freeze acknowledgement was lost. If setup was partial or timed out, finish Retry Offline Setup before ending or downgrading OFFLINE. An already-ended window returns without repeating the recovery flow.

## Verify access and obligations

1. Confirm ordinary public access, sign-in, cookie-aware responses and the removal of the maintenance banner. Verify critical money doors without creating a real payment or payout.
2. Check that group chat is writable and that active calls interrupted for maintenance are represented correctly. Inspect Stream failures in the recovery response rather than assuming a green page means chat recovered.
3. Inspect the discount snapshot restore result. Codes that expired during maintenance remain inactive. A malformed snapshot is retained and reported, never deleted as if restoration succeeded.
4. Inspect Better Stack separately: the incident request is bounded and best effort. Vendor unavailability must not hold a browser request indefinitely; a failed resolve can require a manual vendor action.
5. Review queued Booking remediation requests and the `maintenance-booking-remediation` job history. It resumes after OFF, one booking per fifteen-minute slice. Check failed items and the corresponding refund-owed/notification outboxes. Never repeat an ad hoc raw gateway refund for an owed marker.

## Reconciliation

Recovery does not start an unbounded parallel reconciliation run. Use the authenticated System Jobs console or bounded cleanup HTTP routes for payment/refund status, dispute, payout status and vendor storage checks. Inspect each result before requesting the next slice. The scheduler resumes normal cadence and processes outstanding obligations independently of the recovery response.

Retain the statutory follow-ups returned by recovery: inspect the GST outward register before filing, run IRP registration within its statutory window, regenerate the quarter's TDS draft when appropriate, and inspect ledger audit findings before reopening payouts. Do not submit statutory filings from a smoke test.

## Deployment and failback

Keep active and standby builds compatible with the same reviewed schema. Exercise restoration and rollback in an isolated environment; production execution records and vendor requests are not a test fixture. Schema generation is local only. Database schema changes and sidecar application require the established explicit production procedure.

## Deprecated & Superseded Approaches

Recovery used to publish OFF before unfreezing channels and then launch six reconciliation jobs in parallel. The current control path verifies recovery first, reports failures, and leaves reconciliation to bounded, independently observable jobs. ETA expiration is no longer an alternative recovery mechanism.
