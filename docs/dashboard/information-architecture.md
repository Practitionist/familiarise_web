# Dashboard information architecture: glossary and current navigation trees

This page records the words the dashboards use for their pages and the navigation trees as the builders in `lib/dashboard/nav/` produce them today. It exists because the same word used to mean different things depending on the role: "Recordings" named sessions you hosted in one dashboard and sessions you attended in another, and "Requests" named booking requests, organization allocation requests or support requests. The rule is one word, one meaning. Permission gating is never changed by a rename or a regrouping; the permission matrices in `lib/auth/org-permissions.ts` and `lib/backoffice/capability.ts` stay the single source of truth.

## Glossary

| Term                            | Means                                                                               | Not to be confused with                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Recordings (in Studio)          | Recordings of sessions you hosted, which you can rename, delete or sell as a replay | Session recordings in Library                                              |
| Session recordings (in Library) | Recordings of sessions you attended                                                 | Replays                                                                    |
| Replays                         | A recording listed for sale, which is a product                                     | Raw recordings                                                             |
| Digital products                | Files sold or given away, such as e-books, templates and packs                      | Plan materials                                                             |
| Session documents               | Files exchanged in one specific booking                                             | Plan materials, which are files attached to a plan for its buyers          |
| Billing                         | What you pay, as a learner or as an organization sponsor                            | Earnings, which is what you are paid                                       |
| Booking requests                | Clients asking to book you                                                          | Support cases                                                              |
| Support cases                   | The conversations a person opens with the support team                              | Booking requests                                                           |
| Library                         | Only the buyer's or attendee's library                                              | The organization Catalog, whose icon is `LayoutGrid` rather than `Library` |

In this phase the consultant dashboard keeps "Recordings" (the hosted sessions) and "My purchases" in its Library group, and the learner dashboard keeps "Digital products"; later phases move and replace them.

## Current navigation trees

Each tree is built by a pure function, so the groups below are what the sidebar renders for a viewer who passes every gate. The breadcrumb labels in each file's `*_PAGE_LABELS` map match the item names.

### Consultant (`buildConsultantNav`)

- Work: Home, Booking requests, Appointments, Messages
- Business: Offerings, Availability, Reviews
- Money: Earnings & payouts
- Library: Session documents, Recordings, My purchases
- Grow: Invite & earn
- Operations: Help & support, Settings
- Pinned: View public page. Mobile tabs: Home, Requests, Appointments, Messages.

### Consultee (`buildConsulteeNav`)

- Home, Appointments, Messages
- Library: Session documents, Session recordings, Digital products
- Money: Billing, Invite & earn
- Operations: Help & support, Settings
- Pinned: Find experts. Mobile tabs: Home, Appointments, Messages, Billing.

### Organization (`buildOrganizationNav`)

Items appear only when the viewer's role and the organization's capabilities pass the same gates the pages check.

- Top: Overview, My Program, Compensation, Appointments, Messages, Booking requests, Plan collaborators
- Library: Session documents, Session recordings
- People: Members
- Sponsorship: Programs, Contracts
- Hosting: Catalog (icon `LayoutGrid`)
- Money: Billing, Payouts
- Operations: Help & support
- Insights: Analytics, Audit, Consent

Organization settings is not a rail item. It opens from the avatar menu and from the mobile Menu sheet, which always lists the row for any role that holds a settings section (`canOpenOrgSettings`). A suspended member sees Overview, Appointments and the Library only.

### Workspace (`buildWorkspaceNav`)

- Overview, plus Activity and Spend when the person owns more than one organization
- Operations: Help & support, Workspace settings

## Support wording

The support area is called Support cases wherever the viewer sees it: the first tab of Help & support, the breadcrumb, the case back link and the organization and workspace support page titles. The header Help menu has a personal row that links to the viewer's own cases page. Inside an organization that row reads "My support cases", so it is not mistaken for the organization's triage page behind the sidebar's Help & support; everywhere else it reads "Support cases". Booking "Requests" keeps its name. Find still matches the old words "recordings" and "support requests" through synonyms in `lib/dashboard/nav/find-index.ts`.

## Planned phases

1. Glossary and labels: renames only, no route moves (this page describes the result).
2. A shared buyer Library with Purchases, Session recordings and Session documents for every role that can buy, replacing the temporary "My purchases" and "Digital products" items.
3. A consultant Studio group holding the hosted Recordings and Session documents, and the Sell grouping of offerings into sessions, group programs and products.
4. The organization regrouping into My work, Sponsor and Host, with Billing and Payouts tabs merged to at most three visible plus a "More" menu.
5. Cross-role entry points: a "My library" row in the account menu on every surface and a `library` path in the `/dashboard/go` resolver.
6. Mobile tab changes and legacy redirects for every moved route.

## Deprecated & Superseded Approaches

The organization rail used to carry its own "Organization settings" item under Operations, duplicating the avatar menu entry. It was removed, and the mobile Menu sheet no longer skips the settings row when a rail item points at the same page. Do not add the item back.

The support area used to be called "Support requests", with a first tab labelled "Requests". Both are now "Support cases", and "Requests" is reserved for booking requests. The component `SupportRequestView` and the `requestsHref` property keep their old identifiers; only the words the viewer reads changed.

The Catalog item used the `Library` icon, which collided with the learner's Library group. It now uses `LayoutGrid`.
