---
title: Novu console conditions for notification scoping
band: 50-operations
audience: operator
status: live
last-reviewed: 2026-11-06
---

# Novu console conditions runbook

[ADR 23](../70-design-decisions/23-notification-scope.md) made notifications carry their organization scope and made the organization preference categories writable. Those preferences are enforced by the application, not by the Novu console: Novu workflows carry **no step conditions**, and nothing in the console should be configured to filter bells.

## Where the opt-out is enforced

Postgres is the only copy of notification preferences. `lib/novu/policy.ts` drops a recipient when the workspace routing mode (`OrgWorkspaceProfile.notificationRoutingMode`) is `EMAIL_ONLY` or `NEITHER`, when `allNotifications` or `inAppEnabled` is off, or when the family's category switch is off. It runs when the bell is staged and again at the first attempt, which freezes the allowed recipients so a retry resends exactly that set.

`npm run novu:sync` writes every family with that empty condition set and with read-only, always-on subscriber preferences, so a subscriber cannot mute a family inside Novu either. `npm run novu:check` reports a leftover `skip` control or subscriber-editable preferences as drift.

| Category switch (`NotificationPreference`) | Family           |
| ------------------------------------------ | ---------------- |
| `orgBillingAlerts`                         | `org-billing`    |
| `orgMembershipAlerts`                      | `org-membership` |
| `orgProgramAlerts`                         | `org-program`    |

## The organization categories

Each family maps to at most one category switch (`lib/novu/templates/families.ts`). The mapping follows the audience rather than the noun: an operator who wants invoices but not roster churn, and an expert who wants the reverse, are the two cases the split exists to serve.

### `orgBillingAlerts` — money in and money out

| Workflow slug                  |
| ------------------------------ |
| `org-invoice-issued`           |
| `org-invoice-paid`             |
| `org-invoice-overdue`          |
| `org-wallet-topup-confirmed`   |
| `org-wallet-low`               |
| `org-payout-completed`         |
| `org-payout-failed`            |
| `org-payout-reversed`          |
| `org-member-overage-timed-out` |
| `org-program-overage-due`      |

The two overage workflows sit here rather than under programs because both are addressed to the member who now owes money, not to the operator watching a cap.

### `orgMembershipAlerts` — who is in the organization

| Workflow slug              |
| -------------------------- |
| `org-invite-sent`          |
| `org-invite-accepted`      |
| `org-expert-removed`       |
| `org-sso-provider-deleted` |

The SSO workflow is membership rather than a category of its own: it concerns how people get into the organization. Revisit this if an organization asks for security alerts to be separately non-mutable.

### `orgProgramAlerts` — entitlement and capacity

| Workflow slug                  |
| ------------------------------ |
| `org-program-exhausted`        |
| `org-program-cap-near`         |
| `org-license-renewal-upcoming` |
| `org-data-export-ready`        |

`org-data-export-ready` is the loosest fit. It is operational rather than commercial, and it sits here because it is addressed to the same operator audience as the capacity warnings.

## Verify

For a category, open your personal **Settings → Notifications**, turn **Billing & Payouts** off, and trigger an invoice event for an organization you belong to. Nothing should arrive. Turn it back on and repeat; the notification should arrive.

For routing, set **Notification routing** to `EMAIL_ONLY` in the cross-organization workspace settings, then trigger any organization event. An email should arrive and the bell should stay silent. Both changes apply to the next notification; no reload is needed.

## What is deliberately not conditioned

The `ORG_*` payloads do not carry a `NotificationScope`. They are unambiguous by construction — every one is an organization-lifecycle event and names its organization in the payload — so a scope discriminator would be redundant. The consequence, recorded in ADR 23, is that these notifications appear under the inbox's **All** tab but not under a specific organization's tab, which filters on `organizationId`. If an operator asks for organization-lifecycle events to file under their organization's tab, the fix is to add the scope to those payloads in code, not to add a console condition.

## Deprecated & Superseded Approaches

- **Step conditions over a subscriber mirror (removed)**: the sync used to write a `skip` rule on every in-app step over `subscriber.data.routingBell`, `masterEnabled`, `preferInApp` and `category*` flags that the app copied onto each Novu subscriber. The server already rechecked the same flags in Postgres before every trigger, so the conditions could only drop bells the server had approved. Remove any such condition found in a Novu environment by running `npm run novu:sync`.
