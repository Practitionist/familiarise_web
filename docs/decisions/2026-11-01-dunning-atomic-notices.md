# ADR: Dunning stages its overdue notices in the claim transaction

- **Status**: Accepted on 2026-11-01. Ships in the pull request that adds this record.
- **Date**: 2026-11-01
- **Author**: Platform engineering
- **Related**: [Triage of the GPT-6.1 durable-jobs issues](2026-10-31-gpt-issue-triage.md) (decision 1: this fix gates enabling the org invoice rail), [Email delivery](../email/README.md), [Cross-cutting integrations: dunning](../enterprise/40-compliance-and-data/06-cross-cutting-integrations.md), issue #2489

## Context: a committed dunning stage could lose its notice

The `dunning` job (`jobs/billing/dunning.ts`) moves an organisation invoice through three stages. Each stage claims the invoice with a compare-and-swap update:

1. **Overdue.** `ISSUED` with no `markedOverdueAt` becomes `OVERDUE`, and the job writes an `INVOICE_OVERDUE` audit row.
2. **Reminders.** An `OVERDUE` invoice gets up to 3 reminders, 7 days apart. Each one bumps `dunningReminderCount` and `lastDunningReminderAt`.
3. **Suspension.** With `ENABLE_DUNNING_SUSPEND` on, `dunningSuspendedAt` is stamped 7 days after the last reminder.

Before this change, every stage committed first and only then sent the bell (`notifyOrgInvoiceOverdue`) and the email (`sendOrgInvoiceOverdueEmail`). A crash or a send failure in that gap lost the notice, and the selectors do not pick the row up again:

- stage 1 needs `markedOverdueAt: null`;
- stage 2 needs `dunningReminderCount < 3`;
- stage 3 needs `dunningSuspendedAt: null`.

A lost first notice was covered only by the first reminder, about 7 days later. A lost third reminder or suspension notice was never sent.

Failures before staging were also hidden. The email path caught a roster-read error, logged it and returned, so the run reported `remindersSent: 1, failed: 0` even though no notice existed. The ordinary in-transaction email stager has the same weakness: `stageToRecipients` counts a render failure but returns the remaining list without reporting it.

## Decision

Each stage stages its notices as outbox rows inside the transaction whose claim wins. The cadence and the cap do not change: reminders stay 7 days apart, with at most 3.

1. **One helper per stage.** `stageOverdueNotices(tx, invoice, stage, now)` runs after the claim and the audit row. It makes two calls:
   - `notifyOrgInvoiceOverdue(orgId, payload, { tx, dedupeKey, entityRef })` reads the roster and the bell policy through `tx`, then writes a `NotificationOutbox` row. Because the call passes `tx`, it does not attempt delivery inside the transaction.
   - `stageOrgInvoiceOverdueEmail(tx, args)` writes one `FailedEmail` row for each allowed recipient.

   Every read and write goes through `tx`, so the job never uses the global client while a transaction is open (`PG_POOL_MAX=1`).

2. **Distinct identities.** Each notice has its own dedupe key, `orgInvoice:<id>:overdue:<stage>`, where the stage is 0 for the first notice, 1 to 3 for the reminders and 4 for the suspension notice. The key sets the Novu `transactionId`, and the outbox upserts on it, so staging the same notice again returns the existing row. The email has no unique column, so its at-most-once guarantee comes from the claim: a run that loses the claim stages nothing, and a Serializable retry rolls back everything the failed attempt staged.
3. **A required notice fails loudly.** `stageSpecRequired` (`lib/email/senders/shared.ts`) reads recipients through `tx` and throws if any recipient's render fails. A roster-read failure also throws. The claim then rolls back, the invoice stays where it was, and the next run selects it again. The failure counts in the run's `failed` total, which turns the run's status into 207 once per run. Nothing is sent to Sentry for each row (`AGENTS.md` §4.2). Because a persistent render fault fails the same claim on every run, `stageSpecRequired` calls `prepareRecipientEmails` with `reportToSentry: false`, which turns off the per-recipient render capture that other senders keep. The job logs the failure to the console, and the run outcome is the only report.
4. **Policy outcomes still commit.** An empty roster, a recipient who opted out, a suppressed address and a pre-launch hold (`EMAIL_DELIVERY_MODE`) are intended outcomes, not failures. `stage()` writes a held or suppressed message as a `DEAD_LETTER` row, so the delivery guard still sees every recipient (`AGENTS.md` §4.6).
5. **Delivery happens after commit.** Once the transaction commits, the job calls `attemptTrigger` for each bell and `attemptStaged` for the emails, inside `Promise.allSettled`. If a send fails, the row stays in the outbox, and `drain-notification-outbox` or `retry-failed-emails` delivers it. A failed send never undoes the invoice change.

The change adds no schema, no flag and no scheduler.

## Alternatives rejected

- **Send after commit and keep an "owed" marker.** The job would stamp something like `overdueNoticeOwedAt` with the claim and clear it after a successful send, and a sweep would retry rows that still carry the marker. That needs a schema change during the freeze and a second recovery path next to the two outbox relays that already exist. It also brings back the same gap at a smaller scale: a marker set but not yet acted on.
- **Rely on the 7-day reminder.** This is the old behaviour. It delays the first notice by a week, and it does nothing for the third reminder or the suspension notice, which have no later stage to cover them.

## Consequences

- The claim transaction now does more work: the roster and policy reads, one outbox upsert, the email recipient read and one `FailedEmail` insert per recipient. That is about 6 + N statements, which fits the 15-second transaction timeout for a visibility roster of a few people.
- A template that fails to render stops that stage for that invoice until someone fixes it. The failure shows up as a degraded run on every run instead of a notice that silently never existed.
- The org invoice rail can be turned on once this ships (decision 1 of the triage record).

## Deprecated & Superseded Approaches

- `emailInvoiceOverdue` in the job and `sendOrgInvoiceOverdueEmail` in `lib/email/senders/money.ts` sent the email after commit and swallowed roster errors. Both have been deleted. Any code that sends an overdue notice outside the claim transaction is left over from that approach.
