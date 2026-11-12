# 11-dashboards-roles-notifications (DB-)

The same booking as every role sees it (consultant, consultee, Wipro sponsor owner, LearnPro host owner and expert, staff, admin, a dual-role user); what each role can open and do; org scope and sponsor scheduling; the back office; maintenance and system-job refusals off production; and every bell notification and email a booking event sends: recipient, wording, link, timing and the outbox row.

| File | Cases | Count | What |
| --- | --- | --- | --- |
| [01-same-booking-every-view.md](01-same-booking-every-view.md) | DB-01 – DB-18 | 18 | Viewer matrix; confirmed, requested, awaiting payment, lapsed, being moved, cancelled, completed; subscription, webinar, class, trial; Wipro-sponsored and LearnPro-hosted; dual role; counts vs DB; empty states; unscheduled offerings |
| [02-access-org-scope-maintenance.md](02-access-org-scope-maintenance.md) | DB-19 – DB-30 | 12 | Page access matrix; staff vs admin trees; back-office doors; `orgScope` on every list; org roles; sponsor scheduling after approval; bell link landings; back-office lookup; maintenance controls off production; maintenance owner drill; system jobs off production; deactivated orgs |
| [03-notifications-consultations-subscriptions.md](03-notifications-consultations-subscriptions.md) | DB-31 – DB-48 | 18 | Request, approve (paid and free), decline, remind, lapse, instant booking, every reschedule outcome both directions, cancels both sides, subscription start and nudges, partial placement, week reminder, plan cancel and unscheduled refund |
| [04-notifications-events-trials-money.md](04-notifications-events-trials-money.md) | DB-49 – DB-63 | 15 | Webinar seat and re-time, class series move, session cancel, make-up, session refund and exit right, waitlist and backup interest, trials, conversion, reminders and completion, refunds, org notices, preferences off, dual role, the copy sweep |

Total: 63 cases.

## Fixtures and personas

- **Reuses** the bookings other folders leave (DB-01 builds the ledger): CO-01, CO-12, CO-14, CO-15, CO-17, CO-20, CO-25, CO-36, CO-47, CO-60, CO-71, CO-87; SU-23, SU-37; WE-19, WE-21, WE-34; CL-27, CL-41, CL-51; TR-01, TR-04; TZ-04 (DR's booking).
- **Personas:** all of them. ST and AD use `SEED_OPERATOR_PASSWORD`. Confirm DR's roles and OX's membership with R-01 first (DB-01).
- **Notification SQL:** N-3 (in 11-c) for bell plus email rows; N-1/N-2 (in `../10-timezones-dst-locale/01-cross-zone-odd-offsets-overnight.md`) for rendered times. `NotificationOutbox` holds bells (`workflowId`, `recipients`, `payload`, `status`, `notBefore`); `FailedEmail` holds every email (`emailType`, `recipient`, `subject`, `htmlBody`, `status`). R-07's outbox query omits `workflowId`; use N-3.

## Run order

Run the notification cases (11-c, 11-d) **alongside** the journey folders: right after the step each case names, so the rows are fresh and easy to find. Run 11-a after 03–07 have left their bookings. 11-b any time after 01. Group by persona; ST and AD last.

## Environment

- Bells and emails are staged in the same transaction as the booking change, so previews show them for every non-money journey. Money journeys are `[local]`.
- Sweeps (lapse, expiry, reminders, completion, class refunds, nudges) are NEEDS-OWNER-RUN off production: give the job name and N-3 for the entity.
- Maintenance can only change on production (`MAINTENANCE_PRODUCTION_ONLY`); DB-28 is an owner drill and a static review.

## Scope boundaries

09-concurrency-integrity owns API authorisation attacks; 11-b checks what pages show and say. 10-timezones-dst-locale owns the zone and format of every rendered time (bell rows per zone, email labels); this folder checks recipients, wording and links. 12-sweeps-background-jobs owns sweep mechanics; this folder checks only the notice a sweep sends.

## Salvaged from the old suite

| Old | New |
| --- | --- |
| `e2e-booking-agent-017` Phases 1–4 (sponsor allocate after approval, member can't allocate, outside hours, re-allocate, funding not tag, other org) | DB-24 (org UI and refusal copy); the core journey stays CO-15 |
| 017 Phase 5 (scoped lists table) | DB-22 (extended to every booking list and the inbox) |
| `e2e-booking-agent-008` (maintenance freeze; UI parts only) | DB-27, DB-28; the money invariants (payment survives a freeze, no double refund) belong to 09 |

## Things found while writing this folder (report them, don't assume)

- Inbox approvals map `VALIDATION_ERROR` to "That request could not be read. Refresh and try again.", but the allocator uses `VALIDATION_ERROR` for every plain-copy rule refusal (outside hours, plan week full, too soon). See UX-48.
- "(link valid 24 h)" fallback on the money line (DB-04).
- One payload reaches both parties for reschedule outcomes: the proposer is told "Please review it." (DB-38); the expert is told "You will be told once a new time is set." after a release (DB-40).
- The paid-trial hold email says "free trial" (DB-56).
- Sponsored bookings may link a non-member host to the sponsor org's dashboard (DB-25).
- Only checkout reads the maintenance guard; other booking writes fail late with a 503 that has no `code` (DB-28).
- `jobsMayRunHere()` allows job runs from local development (DB-29).
