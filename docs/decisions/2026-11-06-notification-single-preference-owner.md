# ADR: Postgres is the only owner of notification preferences; Novu is a plain in-app transport

- **Status:** accepted by the owner on 2026-11-06.
- **Related:** PR #2623 (the notification subsystem re-land), `docs/notifications/README.md`, `docs/enterprise/70-design-decisions/23-notification-scope.md` and `30-novu-templates-as-code-and-workflow-families.md` (both partly superseded by this record).

## Context

Before this change a user's notification preferences lived in two places. Postgres held `NotificationPreference` and `OrgWorkspaceProfile.notificationRoutingMode`. A mirror then copied the same flags, plus name, email and phone, onto the Novu subscriber, and each Novu workflow step carried a `skip` condition that read the mirrored flags. The server already rechecked Postgres before every trigger, so the mirror could only drop a bell that the server had approved while the outbox recorded the row as `SENT`. Users could also mute a family on Novu's own preference page, which no Familiarise screen showed or controlled. In-app quiet hours deferred a bell while the email for the same event went out at once. Maintenance notices and announcements were Novu broadcasts with no preference check at all.

Three facts shaped the answer:

1. The Novu Free plan allows 10,000 workflow runs a month, and Development and Production runs are counted against the same quota. Every bell recipient is one run.
2. On 2026-11-06 the live database held zero `PENDING` or `RETRY` rows in `FailedEmail`, `FailedEmailBatch` and `NotificationOutbox`, so no queued row needs a data migration.
3. No maintenance window is ever scheduled ahead (`MaintenanceWindow.scheduledAt` is never set), the bell relay is blocked while maintenance is `OFFLINE` (`blockingPhaseFor` in `lib/maintenance-cron.ts`), and users cannot open the app during that phase anyway.

## Decision

1. **Postgres is the single preference owner.** The Novu preference mirror, the step `skip` conditions and the native-mute adoption UI are deleted. The sync writes every family with `preferences` set to `readOnly: true` (`FAMILY_PREFERENCES` in `lib/novu/templates/index.ts`), and the inbox mounts with `hideNav`, so Novu has no preference editor. The server filters recipients when a bell is staged and again at the first attempt (`lib/novu/policy.ts`). Stray native mutes that users saved on Novu's old preference page are cleared once per environment by `scripts/novu/clear-native-mutes.ts` (dry run first, then `--apply`), before `npm run novu:sync` makes the families read-only.
2. **In-app quiet hours are removed.** The consultant planning reminder (`lib/booking/week-nudge.ts`) still skips a consultant who is inside their quiet hours, for both its email and its bell. When no hours are stored, the defaults of 22:00 to 08:00 apply. The settings control is labelled "Email quiet hours".
3. **Announcement inbox posts are opt-in.** An admin ticks `postToInbox` on create. The audience is capped at `MAX_BELL_AUDIENCE` (2,000 eligible users), and the dialog shows the eligible count and asks for confirmation before posting, because each recipient spends one Novu run.
4. **Maintenance bells are deleted.** `maintenance-scheduled`, `maintenance-started`, `maintenance-ended` and `stageMaintenanceBells` no longer exist. `components/banners/MaintenanceBanner.tsx` covers the `DEGRADED` phase and the middleware maintenance page covers `OFFLINE`. Advance notice goes through an announcement with the opt-in inbox post. The `platform` family now carries only `general-announcement` and `compliance-deadline-alert`.
5. **Email relay status writes are compare-and-set (CAS).** Every status write in `jobs/email/retry-failed-emails.ts`, `settleRow` in `lib/email/deliver.ts` and `settleBatch` in `app/api/admin/waitlist/broadcast/route.ts` is an `updateMany` filtered on `status: UNSETTLED` (`PENDING` or `RETRY`, from `lib/retry/provider-window.ts`). A lost race is skipped and not counted, so a late writer can never overwrite `SENT`. The bell relay already did this (`settleRow` in `lib/novu/outbox.ts`).
6. **The `firstAttemptAt` backfill is skipped.** With zero `PENDING` or `RETRY` rows on 2026-11-06 there is nothing to backfill. The legacy cutover guards (`review:legacy_delivery_format` and `review:legacy_broadcast` in `lib/novu/outbox.ts`) stay until the production release. If a read-only count of `PENDING` or `RETRY` rows is still zero then, a cleanup PR deletes them together with `scripts/novu/clear-native-mutes.ts`.
7. **Novu capacity: stay on the Free plan with the 2,000 cap.** A follow-up adds a usage guard: an ops-digest line that counts monthly bell runs from our own `NotificationOutbox` rows that are `SENT`, summed over their recipients. Upgrade to Pro once monthly runs pass about 60 % of the quota (6,000 of 10,000). Keep Development testing small, because it spends the same quota.
8. **Novu Production is changed at the release promotion.** `clear-native-mutes`, `novu:sync` and `novu:check` for Production run in the same window as the production release that carries this change. The old production code still writes subscriber preferences, so Production must not be synced earlier.
9. **The organisation routing mode stays the account-wide channel gate.** For bells, `EMAIL_ONLY` and `NEITHER` block the recipient. For optional email, `BELL_ONLY` and `NEITHER` block it. Its settings copy is fixed in a follow-up, because no "digest" exists.
10. **Follow-ups, in order.** PR 5 is the settings experience: accessible and optimistic controls, categories filtered by role, honest copy, a preferences panel on the organisation workspace page, an inbox-to-settings link and an unsubscribe undo. PR 6 is consent and erasure: DPDP `MARKETING_COMMS` consent drives the Waitlist newsletter status, the dead `marketingEmails` switch is removed, erasure scrubs queued email rows and the Waitlist, and the cookie banner is removed until a non-essential script ships. PR 7 is the domain producers: render React Email outside money transactions, and send moderation notices after commit. A P3 ops PR follows.

11. **Required bells always ring (amended 2026-11-07).** A bell template marked `required: true` (verification status, new consultant application, moderation warning, account security notice, content removed, suspension, ban, compliance deadline alert; each has `category: null`) skips the master switch, the In-App switch and the routing mode, exactly as a null-category email does; only erasure stops it. `general-announcement` has no category but stays optional. Both gates enforce it: `isBellAllowedForRecipient` and the SQL `bellAllowedWhere` in `lib/novu/policy.ts`, and the real-Postgres parity test covers it. The settings panel built under decision 10 (PR 5) says so in its copy.

## Alternatives considered

- **Keep the mirror and fix its edge cases.** Rejected: a second copy of the flags can only disagree with Postgres, and the server check already makes it redundant.
- **Let users manage preferences in Novu's inbox page.** Rejected: it is a second, invisible owner, and it cannot express the organisation routing mode.
- **Upgrade Novu to Pro now.** Rejected for the pre-launch phase: the 2,000 cap keeps one fan-out at a fifth of the month, and the usage guard raises the alarm well before the quota.
- **Keep maintenance bells and fix their audience.** Rejected: they could never fire usefully, for the reasons in Context.

## Consequences

- A preference change applies to the next notification, because both gates read Postgres at stage time and at the first attempt. No Novu write is involved.
- `npm run novu:check` reports a leftover `skip` control or an editable preference as drift, so a console edit cannot silently bring the second owner back.
- Production Novu and the production release are coupled. If the release slips, the Production sync waits with it.
- The Novu activity feed keeps only 24 hours of history on Free, so our own `NotificationOutbox` is the delivery audit trail.

## Deprecated & Superseded Approaches

- The Novu subscriber preference mirror (`updateSubscriberPreferences`, `syncSubscriber`) and the step `skip` rule (`inAppSkipRule`) are superseded by decision 1. Delete any residual reader of `subscriber.data` flags.
- Novu broadcasts for announcements and maintenance (`notifyGeneralAnnouncement` as a broadcast, `notifyMaintenanceScheduled`, `notifyMaintenanceStarted`, `notifyMaintenanceEnded`) are superseded by decisions 3 and 4. The `BROADCAST` outbox kind is unused.
- Bell deferral by quiet hours is superseded by decision 2.
