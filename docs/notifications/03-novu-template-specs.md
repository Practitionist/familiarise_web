# Novu Templates — Where They Live and How to Change One

> Novu templates are code. This page says where the code is, how a change reaches Novu, and the rules a template body must follow.

**Last Updated**: 2026-11-06

## Source of truth

Every in-app notification (subject, body and the payload field that holds the tap destination) is written in `lib/novu/templates/`:

| File          | What it holds                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `b2c.ts`      | In-app templates for the consultant, consultee, staff and admin events                                         |
| `org.ts`      | In-app templates for the `ORG_*` events                                                                        |
| `families.ts` | The 16 workflow families, their opt-out category and `EVENT_FAMILY`, the map from each of the 97 events to one |
| `types.ts`    | `WorkflowTemplate`, `InAppTemplate` and `PreferenceCategory`                                                   |
| `index.ts`    | `toWire` (event to family), the family document the sync writes, and `FAMILY_PREFERENCES`                      |

The Novu environment holds one workflow per family, not one per event. Each family's body is one Liquid `case` over `payload.event`, built from the member templates at sync time. The complete list of families and their events is in [02-workflows-and-api.md](./02-workflows-and-api.md#workflow-families), and the reasoning is in [ADR 30](../enterprise/70-design-decisions/30-novu-templates-as-code-and-workflow-families.md). Email is not a Novu concern: no family has an email step, and email copy lives in `emails/` (see [../email/README.md](../email/README.md)).

## Changing a template

1. Edit the template in `lib/novu/templates/b2c.ts` or `org.ts`. For a new event, also follow "Adding a New Notification" in [02-workflows-and-api.md](./02-workflows-and-api.md).
2. Run `npm run novu:sync -- --dry-run` to preview the change, then `npm run novu:sync` to write it to Development.
3. Wait five minutes after a sync, because Novu serves stale reads right after a write, then run `npm run novu:check`. It exits non-zero on any drift, including a leftover `skip` condition or a subscriber-editable preference. Treat the result as clean only after two clean runs.
4. Production is written only at the release promotion that ships the change, with `npm run novu:sync -- --env production` and then `npm run novu:check -- --env production`. See [05-pre-production-checklist.md](./05-pre-production-checklist.md).

Never create or edit a workflow by hand in the Novu dashboard. The next sync would overwrite it, and a hand-made per-event workflow would also spend one of the plan's 20 workflow slots.

## Template rules

- **Reference fields only through `payload.` and `subscriber.`.** A bare Liquid variable is a bug, and `__tests__/notifications/novu-templates.test.ts` refuses one. The same suite requires every event to belong to exactly one family and checks that a family is written always-on, read-only and without a step condition.
- **Print the customer-ready field as-is.** Payload values are already written for a person: `dateTime` is a sentence in the recipient's own timezone, `amountFormatted` is money with its symbol, and `appointmentType` is a label. The machine-readable original travels beside it under a unit-suffixed name (`dateTimeIso`, `amountPaise`, `appointmentTypeCode`). A template never formats a date or an amount itself; see "Payload conventions" in [02-workflows-and-api.md](./02-workflows-and-api.md).
- **One payload often reaches both parties.** Name the plan and the time. Name a person only where every reader is the other party.
- **The redirect cannot branch.** Novu accepts a redirect that starts only with `{{...}}`, `http(s)://` or `/`, so a template names the payload field that holds its destination (`redirect: "dashboardUrl"`), `toWire` copies it into `payload.href`, and every family redirects to `{{payload.href}}`.
- **Families carry no step conditions and no editable preferences.** The sync writes `FAMILY_PREFERENCES` (always on, read-only). Postgres decides who receives a bell; see [the decision record](../decisions/2026-11-06-notification-single-preference-owner.md).

## Producers stage inside the transaction

A route that owes a notice stages it inside the transaction that makes the business change: one `NotificationOutbox` row per bell and one `FailedEmail` row per email, with no vendor call. It runs the vendor attempts after the response through `flushNotificationsAfter` (`lib/novu/stage-then-attempt.ts`, which uses `scheduleAfter` in `lib/api/after-safe.ts`). The rows and the change commit or roll back together, so a notice cannot exist for a change that rolled back and a change cannot commit without its notice. Every read inside the transaction goes through `tx`, because a global-client read while the transaction holds the single Netlify connection deadlocks (`PG_POOL_MAX=1`). The architecture page ([01-architecture.md](./01-architecture.md)) has the full pipeline.

## Deprecated & Superseded Approaches

- **Hand-built workflows in the Novu editor.** The first workflows were built by hand in Novu's legacy editor from a copy-paste spec that listed an HTML body and a Handlebars template for each event, and a second set of email steps that were never created. The spec and the console drifted apart within a week (a ticket notice shipped with an empty status), only 19 of the events had a workflow at all, and the plan's 20-workflow cap made one-workflow-per-event impossible. Templates as code and workflow families replaced it. Delete any residual copy-paste template body, Handlebars variable or instruction to configure a Novu email step.
- **Novu email steps and the Resend integration inside Novu.** Email is sent directly by the app so that transactional mail never depends on a second vendor's queue. There is no Resend provider to configure in Novu.
- **Per-workflow opt-out settings in the Novu console and step `skip` conditions.** Postgres is the only preference owner now.
