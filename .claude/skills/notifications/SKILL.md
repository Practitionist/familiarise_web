---
name: notifications
description: Work on this repo's notification subsystem — in-app bells through Novu and email through Resend, both written first to a Postgres outbox (FailedEmail, FailedEmailBatch, NotificationOutbox) and finished by relays on the ticker; Postgres as the single owner of notification preferences (NotificationPreference); adding a notification event or Novu workflow family; staging a bell or email inside a transaction; announcement inbox posts; dead-letter reasons; Novu quota. Use when the user says "notification", "bell", "inbox", "Novu", "novu:sync", "outbox", "dead letter", "preferences", "quiet hours", "announcement", "retry-failed-emails", "drain-notification-outbox", or is touching lib/novu/, lib/email/, emails/, jobs/email/, components/notifications/, app/api/novu/, app/api/announcements/, or scripts/novu/.
---

# Notifications

Terse rules for agents. The human explanation is in `docs/notifications/` (start at `docs/notifications/README.md`); email specifics are in `docs/email/README.md`; the decision record is `docs/decisions/2026-11-06-notification-single-preference-owner.md`. Every rule names its enforcer. Grep before you assert any name.

## The model

- Postgres is the transactional outbox (`FailedEmail`, `FailedEmailBatch`, `NotificationOutbox`) and the **only** owner of notification preferences (`NotificationPreference`). Workspace routing is removed: `OrgWorkspaceProfile.notificationRoutingMode` is unread until the next schema batch drops it, so never read or write it.
- Resend sends email. Novu is a plain in-app transport: 16 workflow families (`lib/novu/templates/families.ts`), in-app only, `readOnly: true` preferences (`FAMILY_PREFERENCES` in `lib/novu/templates/index.ts`), no step `skip` conditions, no subscriber profile or preference data. 94 events: `Object.keys(NOVU_WORKFLOWS).length === Object.keys(EVENT_FAMILY).length`.
- The inbox mounts only with a signed HMAC (`POST /api/novu/subscriber`, `lib/novu/inbox-auth.ts`) and `hideNav`, so Novu has no preference page.
- The server gates every bell twice: when staged (`resolveRecipientBellPolicy`, `bellAudience` in `lib/novu/policy.ts`) and at the first attempt of each generation (`currentBellRecipients`). The personal switches are the only channel control for every user, operators included: `allNotifications` and `inAppEnabled` for bells, `allNotifications` and `emailEnabled` for optional email, then the category column. A template marked `required: true` (security, account, verification, moderation and compliance notices; always `category: null`) skips the switches for bells, as a null-category email does; only erasure stops it. `general-announcement` has no category but is not required.

## How a producer stages

- **Bell inside a transaction:** `stageBell(tx, { workflowId, recipients, payload, dedupeKey, entityRef })` (`lib/novu/stage-bell.ts`). It returns `null` when policy drops everyone. Fan-out to a list uses `stagePages(tx, ...)` (`lib/novu/outbox.ts`), pages of at most 100 recipients, recipients already policy-filtered.
- **Bell outside a transaction:** the `notify*` functions in `lib/novu/service.ts` (and `lib/novu/org-workflows.ts`) stage, then attempt. Pass `{ tx }` or `deferAttempt: true` to stage only.
- **Email:** `deliver()` (`lib/email/deliver.ts`) stages then attempts. Inside a money, payout, dunning or moderation transaction, render before it opens with the sender's `prepare*Email(args)` (or `prepareBuiltSpec`, `lib/email/senders/shared.ts`) and pass the result to `stage*Email(tx, args, pre)`, which only inserts rows; if the in-transaction `args` differ from the pre-render's, it renders inside instead (decision 15). Only an input that exists after the write justifies rendering inside `tx`, and a render failure there stages nothing and never throws.
- **Required email:** set `traceRenderFailure: true` on the spec (receipts, refund notices, dunning). A render failure then stages a body-less `DEAD_LETTER` row with `lastError` `review:render_failed` in the same transaction instead of a Sentry event; replay refuses it. Never let a notice's render failure roll back the business write.
- **After commit:** pass the staged rows to `flushNotificationsAfter({ bells, emails }, op)` (`lib/novu/stage-then-attempt.ts`). It attempts them in `scheduleAfter` (`lib/api/after-safe.ts`); a row it cannot settle waits for the relay.
- **`tx` only:** inside `prisma.$transaction`, every helper receives and queries `tx`, never the global client. `PG_POOL_MAX=1` on Netlify deadlocks otherwise (`loadEmailRecipients(userIds, category, tx)`, `bellAudience(tx, ...)`).
- Await every call. An un-awaited call is lost when the Netlify instance freezes after the response.

## Add an event

1. Add the id to `NOVU_WORKFLOWS` and a typed payload in `lib/novu/workflows.ts`.
2. Add the `notify*` function in `lib/novu/service.ts` with the matching `define*Notifier`.
3. Add the template to `lib/novu/templates/b2c.ts` or `org.ts` and map the event in `EVENT_FAMILY`. `__tests__/notifications/novu-templates.test.ts` requires exactly one family per event and refuses a bare Liquid variable.
4. `npm run novu:sync -- --dry-run`, then `npm run novu:sync`, then `npm run novu:check`. Novu's read API serves stale workflows for about three minutes after a sync, so a `novu:check` in that window reports false drift on random families; wait five minutes, then expect two clean runs in a row. Never build a workflow by hand in the Novu dashboard; the event is not a workflow, its family is, and the plan caps an environment at 20.
5. Update the family table in `docs/notifications/02-workflows-and-api.md`.

Every family redirects to `{{payload.href}}`, and `toWire` always sets it (the event's destination, else `FALLBACK_HREF`). Never let it render empty: Novu then fails the in-app step for every recipient while the trigger reports `processed`, so the outbox row settles `SENT` and the bell is lost silently. `__tests__/notifications/novu-templates.test.ts` checks every event.

## Relays and cadences (`lib/cron/schedule.ts`)

| Job                         | Cadence                                             | Limit | Budget |
| --------------------------- | --------------------------------------------------- | ----- | ------ |
| `drain-notification-outbox` | every 10 min at offset `:05`                        | 100   | 24 s   |
| `retry-failed-emails`       | every 15 min at offset `:05` (`:05, :20, :35, :50`) | 20    | 20 s   |

Both are registered once in `lib/cron/cleanup-registry.ts` and run under `withCronLock`. A new row waits 60 s (`INLINE_ATTEMPT_LEASE_MS`) so the relay does not race the inline attempt. The relay is blocked while maintenance is `OFFLINE` (`blockingPhaseFor`, `lib/maintenance-cron.ts`). Production's job fleet is paused pre-launch; resume from the go-live skill.

## Settles are compare-and-set

- Every status write on all three outbox tables is a conditional `updateMany` filtered on `PENDING`/`RETRY`: `UNSETTLED` (`lib/retry/provider-window.ts`) for email in `settleRow` (`lib/email/deliver.ts`), the relay (`jobs/email/retry-failed-emails.ts`) and `settleBatch` (`app/api/admin/waitlist/broadcast/route.ts`), and `ACTIVE_STATUSES` for bells (`lib/novu/outbox.ts`). A lost race matches no row, is skipped and is not counted. Never write a settle as read-then-update, and never overwrite `SENT`.
- Novu honours the Idempotency-Key (measured 2026-11-07 in Development: two triggers, one notification). The terminal-split row id is `<transactionId>:terminal:<digest>`, a 16-hex-character sha256 prefix over the sorted refused recipients (`terminalSplitRow`, `lib/novu/outbox.ts`).
- A Novu step failing after Novu accepted the trigger leaves the row `SENT` and is visible only in Novu's 24 h activity feed; closing that gap is a follow-up (decision 10), so do not treat `SENT` as proof a bell rendered.
- `firstAttemptAt` anchors the provider idempotency key (`stampFirstAttempt`). An automatic replay 23 h (`PROVIDER_REPLAY_WINDOW_MS`) or more after it dead-letters as `review:provider_acceptance_unknown`, because both Resend and Novu cache keys for 24 h.

## Dead-letter reasons (`lastError`)

- **Expected, never page, excluded from the ops digest and Needs attention:** `policy:` (a recipient opted out after staging, e.g. `policy:audience_revoked`), `suppressed:` (email address on `EmailSuppression`), `held:pre-launch` (the `EMAIL_DELIVERY_MODE` guard, `lib/email/held.ts`).
- **Actionable:** every `review:` reason — `review:provider_acceptance_unknown`, `review:render_failed` (a required email whose template threw; fix the template, never replay), `review:legacy_delivery_format`, `review:legacy_broadcast` (legacy cutover guards in `lib/novu/outbox.ts`, to be deleted after the production release), `review:batch_recipient_suppressed`. A terminal Novu refusal (`trigger_not_active`, workflow not found, `invalid_recipients`) splits into its own `DEAD_LETTER` row.
- Expected prefixes: `EXPECTED_REFUSAL_PREFIXES` (`lib/email/replay-policy.ts`), `EXPECTED_BELL_DEAD_LETTER_PREFIXES` (`lib/backoffice/queue-predicates.ts`).

## Quota math

Novu Free is 10,000 workflow runs a month, counted across Development **and** Production; every bell recipient is one run (`.claude/skills/billing-guardrails/references/novu.md`). `MAX_BELL_AUDIENCE` (2,000) caps one announcement fan-out at a fifth of the month. Upgrade to Pro at about 60 % of the quota. Keep Development testing small. The activity feed keeps only 24 h on Free, so `NotificationOutbox` is the audit trail.

## Announcements and quiet hours

- An announcement reaches inboxes only with `postToInbox` on create; the dialog shows the eligible count (`GET /api/announcements/audience`) and asks for confirmation. Staging takes no advisory lock; each post is keyed `announcement:<id>`. `linkUrl` is `http(s)` only (`schemas/announcements.ts`); `PATCH /api/announcements/[id]` parses a strict `UpdateAnnouncementSchema`; admins list every row through `GET /api/announcements/manage`.
- There are no maintenance bells. Live state is `components/banners/MaintenanceBanner.tsx` (`DEGRADED`) and the middleware page (`OFFLINE`).
- In-app quiet hours are removed. Only the consultant planning reminder (`lib/booking/week-nudge.ts`) reads `quietHours*` (22:00 to 08:00 when unset), for both its email and its bell.

## Settings and unsubscribe

- `PUT /api/novu/preferences` parses the strict `NotificationPreferenceUpdateSchema` (`schemas/user.ts`): an unknown key, a non-`HH:MM` time, an unknown zone or an empty quiet window is a 400. GET and PUT answer through `NotificationPreferenceSchema`.
- The panel shows only the switches `receivableSwitches` (`lib/notifications/receivable.ts`) returns for the viewer's role. A new category, or an event sent to a new audience, updates that map, its test and the role table in `docs/notifications/02-workflows-and-api.md`.
- Panel saves are optimistic and share one mutation scope (serialized); never write a preference from a time input's `onChange`.
- The bell-header gear is overlaid at offsets measured on `@novu/react` 3.19.2: the ⋯ row starts 10 px below the popover top and the gear sits 8 px left of ⋯ (`components/notifications/NotificationInbox.tsx`). Recheck both on any Novu SDK upgrade.
- The unsubscribe undo is `POST /api/notifications/resubscribe`, same-origin only (`isSameOriginRequest`), with no `GET`. Neither route's `GET` may ever write.

## Never

- Never call `novu.trigger` or the Resend SDK outside the outbox and `deliver()` (`lib/email/deliver.ts`); every send must pass the `EMAIL_DELIVERY_MODE` guard and the suppression check.
- Never store or read preferences in Novu: no `subscriber.data` flags, no `updateSubscriberPreferences`, no step `skip`, no native-mute UI. `npm run novu:check` fails on a leftover.
- Never `Sentry.capture*` per row in a relay loop. Collect failures and report once per run (the 5,000-a-month quota).
- Never use the global `prisma` inside `$transaction`.
- Never run `npm run novu:sync -- --env production` before the release promotion that carries the change: old production code still writes subscriber preferences.

## One-time operations (Novu)

`scripts/novu/clear-native-mutes.ts` (dry run, then `--apply`, `--env production` for Production) clears stray native mutes **before** `npm run novu:sync` makes families read-only. `scripts/novu/scrub-subscriber-pii.ts` (same flags) nulls the email, names, phone, avatar and `data` that the old mirror copied onto subscribers. It prints counts and field names only. Development was scrubbed on 2026-11-07; Production runs at the release promotion. Previews built on older code can write the profile data back until they rebase. Both scripts are deleted after the Production run. Production steps are in the go-live skill and `docs/notifications/05-pre-production-checklist.md`.

## Vendor configuration is not in the code

Code audits and tests cannot see what is set in the Resend, Novu or Netlify dashboards, and that is how these drifted unnoticed until 2026-11-07: missing Resend webhook events, unknown Production HMAC and leftover subscriber PII. Check them with the vendor MCPs or CLIs (`mcp__resend__list-webhooks`, `mcp__novu__get_workflows` plus `npm run novu:check`, the Netlify env reader, and the Resend CLI at `~/.resend/bin/resend`). The list to check is go-live checklist §4.1. Resend's one webhook subscribes to `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed`, `domain.updated` and `domain.deleted`. `contact.*` is not subscribed, because the app does not use Resend Contacts.

## Verify

`npx jest __tests__/notifications __tests__/email/unsubscribe.test.ts` (outbox, preferences single owner and strict PUT, the settings panel, the role map, templates, sync, clear-native-mutes, unsubscribe and resubscribe) and `npx tsc --noEmit`. For a new event, `npm run novu:check` against Development (wait five minutes after a sync and require two clean runs).

`__tests__/db/notification-outbox.db.test.ts` runs against real Postgres (see the booking verification reference, §11) and pins policy SQL/JS parity, page dedupe, the terminal split and compare-and-set settles.

Relay fault drills run locally, never on a preview: previews refuse every relay and job run (`JOB_RUN_PRODUCTION_ONLY`), because they share the production database. Run `runNotificationDrainTick` (`jobs/notifications/drain-notification-outbox.ts`) against the disposable `localhost:5432/ci` Postgres with `NOVU_DEVELOPMENT_KEY` only, never the shared database URL, and set dummy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, because `lib/redis.ts` throws at import without them.
