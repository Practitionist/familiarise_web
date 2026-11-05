# Notification schema reference

The schema stores delivery obligations, provider evidence and user policy in Postgres. This page describes the notification PR's implementation; its additive columns must be rolled out before deployment. It does not claim the shared database already matches this branch.

## Delivery obligations

| Model                | Content and identity                                                                                                                                 | Recovery fields and indexes                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `FailedEmail`        | Recipient, sender/reply-to, subject, rendered HTML/text, email type, business `entityRef`, optional recipient `deliveryPolicy`, provider `resendId`  | `status`, `attempts`, `nextRetryAt`, `lastError`, `sentAt`, timestamps; indexes on status/retry, status/update and entity reference |
| `FailedEmailBatch`   | Validated immutable provider `payload`, unique `idempotencyKey`, email type                                                                          | Same status/retry fields and status/retry/update indexes                                                                            |
| `NotificationOutbox` | Workflow event ID, `SINGLE`/`MULTI`/`BROADCAST` kind, subscriber IDs, payload, unique `transactionId`, optional business `entityRef` and `notBefore` | Same status/retry fields; indexes on status/retry, status/update, entity reference and workflow/creation                            |

Business mutations and required staging use the same transaction client. Provider attempts happen after commit. A staging failure rolls back its owning transaction; provider failure leaves committed work for the existing relay. Credential bodies are redacted and are never replayed.

`FailedEmail.deliveryPolicy` is nullable JSON containing the recipient account ID and an explicit category, including null for required mail. New recipient-aware rows use it to recheck current identity, address and optional preferences before delivery. Old rows and direct-address messages have no inferred account/category context. Internal policy is removed from provider payloads.

Batch payloads and their idempotency keys stay together. If any newsletter recipient loses eligibility, the entire batch receives a terminal cancellation. Editing the recipient list under a possibly accepted key would make retries ambiguous.

`NotificationOutbox.transactionId` is derived at staging and supplied as the Novu idempotency header. Provider deduplication has a finite window and requires vendor enablement; the unique local ID alone cannot guarantee exactly-once external delivery. Collaborator lifecycle revisions include the row ID, event and update timestamp. Referral rewards use referral IDs; confirmed credit-redemption notices use payment IDs.

`notBefore` defers routine quiet-hours bells and future announcement publications. Announcement payloads also preserve source/revision context, checked against the current record before delivery. Expected cancellations retain an audit row without appearing as actionable delivery failures.

## Provider evidence and suppression

| Model              | Fields                                                              | Purpose                                                                                                    |
| ------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `EmailEvent`       | Unique `svixId`, `resendId`, type, recipient, payload, receipt time | Signed Resend callbacks, deduplicated by callback identity; indexes support message/recipient/time lookups |
| `EmailSuppression` | Email primary key, reason, optional source event, creation time     | Permanent-bounce, complaint and manual suppression checked at staging and delivery                         |

`SENT` records provider acceptance. Delivery callbacks are separate evidence and do not prove a person read a message. Suppression continues to apply to required account messages.

## Preferences and pending Novu mirror

`NotificationPreference` maps to `notification_preferences`; `userId` is unique and cascades with the user. It stores master/channel/category switches and quiet-hours start/end/timezone. Postgres is the policy authority. Novu subscriber custom data is a derived mirror, never the source for email eligibility.

| Additive field/index          | Contract                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `novuSyncToken String?`       | Unique revision token written with a preference, routing or consent change. Acknowledgement clears only that exact revision. |
| `novuSyncPendingAt DateTime?` | Oldest pending work is selected by the existing notification relay and included in its backlog-age signal.                   |
| Index on `novuSyncPendingAt`  | Supports bounded pending-user reads without a new queue table or scheduler.                                                  |

The worker rereads the current profile, preferences, workspace routing and valid marketing evidence. Provider failures retain the revision and move its queue timestamp behind other pending users, so a bounded failed batch cannot starve later changes. The age signal measures the current queue timestamp, not total time since the first failed attempt. If an older in-flight write finishes after a newer acknowledgement, the current account is marked pending again. Missing/erased accounts are not provisioned from a stale queued snapshot. External API ordering and erasure races still need controlled acceptance tests.

Marketing eligibility also uses current Familiarise `ConsentArtifact` evidence for the current terms version. Grants/withdrawals and the marketing switch commit together. Withdrawal unsubscribes current matching waitlist enrollment; granting does not create enrollment or cookie permission. No existing consent is invented or backfilled.

## Status vocabulary

The three delivery tables reuse `EmailDeliveryStatus`: `PENDING`, `RETRY`, `SENT`, `DEAD_LETTER`. `PENDING` includes future floors and temporary unavailable-policy reads. Retriable delivery failures advance backoff; terminal refusals or exhaustion enter `DEAD_LETTER`. Expected source/audience cancellations use that terminal value with a non-actionable reason.

The subscriber mirror uses nullable pending markers on the preference row rather than adding another status enum. A pending marker means the local change is saved and its vendor mirror still requires acknowledgement.

## Applying this branch

The required additions are nullable `FailedEmail.deliveryPolicy`, nullable `notification_preferences.novuSyncToken`, nullable `notification_preferences.novuSyncPendingAt` and the pending-time index. No backfill or shared-database write is part of this audit.

The owner must review read-only drift and use the canonical human-run schema preflight/push with SQL sidecars before deploying these readers/writers. A raw Prisma push can drop sidecar uniqueness, so it is not a substitute. Local `prisma generate` only updates generated client code.

See [delivery architecture](01-architecture.md), [journey audit and rollout evidence](07-journey-audit.md), [email delivery](../email/README.md) and [the outbox/ticker decision](../enterprise/70-design-decisions/27-state-as-outbox-and-scheduled-ticker.md).

Subscriber synchronization provisions verified accounts only. Unverified revisions remain pending until verification; the worker and pending-age signal exclude them while waiting. This preserves the auth lifecycle's verified-address boundary.

## Deprecated & Superseded Approaches

Earlier schema notes said `notBefore` was unused and treated a stable provider key as permanent deduplication. Both are inaccurate: quiet hours/publications use due floors, and provider windows are finite. Fire-and-forget post-commit staging for the collaborator/referral journeys covered here has been replaced by transaction-local staging. Preference mirroring no longer relies solely on a best-effort API call. Historical tables are not new additions in this PR; only the explicitly listed nullable fields/index require rollout.
