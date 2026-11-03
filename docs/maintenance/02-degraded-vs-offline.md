# DEGRADED and OFFLINE

| Behavior                                 | DEGRADED                | OFFLINE                                         |
| ---------------------------------------- | ----------------------- | ----------------------------------------------- |
| Public browsing                          | Banner; reads available | Maintenance page on non-exempt navigation       |
| Selected booking and money writes        | Denied with 503         | Non-exempt APIs denied with 503                 |
| Financial cron jobs                      | Held                    | Held                                            |
| Other guarded cron jobs                  | Allowed                 | Held                                            |
| Existing Stream calls and group channels | No automatic drain      | Offline setup drains calls and freezes channels |
| Discount codes                           | Unchanged               | Original active snapshot paused                 |
| Booking cancellations                    | Never implicit          | Never implicit                                  |
| Better Stack                             | No new incident         | Best-effort incident with bounded request       |

`lib/maintenance-edge.ts` defines the current route exemptions and DEGRADED write patterns. Auth, webhook ingestion, health and ADMIN maintenance control remain exempt. Bypass credentials are privileged operational access; browser cookies use signed expiry tokens. Keep the raw bypass secret out of browser cookie values.

DEGRADED also blocks the admin money-write surfaces: manual capture/refund/payout actions, wallet and earning repairs, financial freezes/releases, and support actions that move money or release payout holds. The current deny patterns and named support gates remain in lib/maintenance-edge.ts and the canonical support services. A maintenance bypass does not bypass those financial write guards.

See [the money gate and recovery reference](../finance/70-operations/03-maintenance-gate-and-recovery.md) for the current route patterns and money-worker admission rules.

## Unreadable state

A missing or malformed maintenance phase is unknown, rather than OFF. Failed refreshes can retain the last known page presentation, but carry `unreadable` so non-exempt writes fail closed. Cron guards refuse unknown state. A successful OFF read remains cacheable; the gate is not a cross-host instantaneous barrier. In-flight requests and jobs are not cancelled when phase changes. Wait for in-flight work to settle and inspect active execution leases before changing the schema.

## Remediation policy

If scheduled maintenance disrupted bookings, use the separate Booking remediation panel. Preview the exact interval and selected booking IDs, then type the confirmation. The server queues up to 20 whole-booking cancellations under a five-minute signed preview and records the ADMIN reason. The worker executes after maintenance ends, one booking at a time. Financial and notification obligations persist in the existing outboxes.

This retains the existing cancellation policy, including full refundable-balance refunds through canonical rails and subscription period extension. It does not introduce the different retrospective `PlatformIncident` remedy policy. Use the Incidents surface for an already-ended outage when that policy is intended.

## Ending maintenance

The ETA is informational. Only successful ADMIN recovery publishes OFF. Failed health checks, discount restoration or channel unfreeze leave the gate active. Check returned recovery errors, restore prerequisites, then retry. Repeated successful DELETE calls return already-ended without launching another recovery fleet.

## Deprecated & Superseded Approaches

An absent Redis phase used to be treated as OFF, and an unreadable cron phase allowed jobs to proceed. Active keys formerly expired after ETA plus grace. OFFLINE used to call the booking freeze automatically. These behaviors are replaced by explicit state, fail-closed mutation gates and separate confirmed remediation.
