# ADR: One Support inbox, and a case page per request

- **Status**: Accepted
- **Date**: 2026-09-27
- **Part of**: #1527, PR #1842

## Context

The back office ran two separate list pages for the same underlying work: a Tickets page for platform-level `SupportTicket` rows and a Conversations page for per-appointment `AppointmentSupportThread` rows. A thread that escalated into a ticket then showed up on both pages, so the same problem could be worked twice, and staff had no single view of "everything that needs a reply." On the user side, every support conversation opened in `SupportThreadSheet`, a drawer stacked on top of whatever page the user was already on; a drawer cannot be linked, bookmarked, or reopened from a notification without re-deriving its trigger, and a support conversation is exactly the kind of thing a user wants to return to later.

## Decision

### One inbox, a case is a ticket or a thread

The back office now has one Support inbox instead of two pages. A _case_ is either a `SupportTicket` (platform-level, or a conversation folded in once it escalates through `supportTicketId`) or an `AppointmentSupportThread` that has not yet escalated (session-level, self-serve first). Folding an escalated conversation into its ticket means the same problem appears once, not twice. The inbox offers five views (Needs reply, Mine, Unassigned, Self-serve only, All) and a Session/Platform filter, all as URL state, server-paginated by merging each table's sort keys and bounded at 1,000 rows deep. `GET /api/staff/support-inbox`, its `/stats` sibling and its `/[caseKey]` case route are all gated on `tickets.manage`; the context pane's email is shown only to a viewer who also holds `users.read`, and its payment card only to one who holds `payments.read`.

### No modals, a URL per case

Each case now opens at its own URL, `support/t_<ticketId>` or `support/s_<threadId>` (`lib/support/case-key.ts`), rather than in a drawer or a modal. At `lg` and above the case opens beside the list; below `lg` the list and the case are separate pages. This makes a case linkable from a notification, from search, and from the browser's own history, and it lets a stale `s_` link that has since escalated redirect to the ticket's case instead of 404ing. The case workspace itself is three panes — context (person, booking, payment, org, the last five cases), conversation (a unified timeline over thread messages and ticket responses, with separate Reply and Private note drafts, the note kept per case in `localStorage`), and assist (Help Center articles by topic, a static saved-reply registry, and quick actions that only deep-link existing guarded flows rather than duplicating their logic).

### User-side full pages

The user side gets the same treatment: `SupportThreadSheet` is deleted, and every support request now has a full page at `…/support/requests/[caseKey]` in the consultee, consultant, organization and org-workspace trees, with a status timeline, the booking or payment card, the conversation, a composer, and three Help Center answers. `PlatformSupportSheet` is the one exception kept as a sheet, because it serves a chat-unavailable caller rather than an ongoing conversation.

### Keying by booking on the user side

A session conversation does not exist until its first message — a thread is only created on the first turn, so an unanswered "Get help" click must not file an empty conversation into the ops queue. The user side therefore keys a session conversation by its booking, `b_<appointmentId>` (`case-key.ts`'s third prefix, alongside `t_` and `s_`), so "Get help" can navigate to a stable URL before the thread row exists. `GET /api/user/support-tickets/[ticketId]` is owner-scoped in its query and never reads private notes, since a requester must never see a staff-only note even by inspecting the response.

### Voice and video calls are out of scope

This round covers text-based tickets and conversations only. Escalating a case into a live voice or video call with a staff member is deliberately out of scope for PR #1842 — the case workspace's assist pane deep-links existing flows rather than opening a new communication channel, and no call type or Stream integration was added here. That work is tracked in #1849, which starts from a scheduled callback for org accounts, reuses the existing Stream call type, and keeps recording and transcription off unless the user consents.

## Consequences

### Positive

- A case can no longer appear twice in the back office's queue, because folding an escalated thread into its ticket is structural (one `supportTicketId` foreign key), not a display-layer dedup.
- Every case and every user support request is now a real URL: it survives a page refresh, a shared link, and a notification deep link, none of which a drawer could do.
- The three permission grants (`tickets.manage`, `users.read`, `payments.read`) compose per field rather than per page, so a staff role without `payments.read` still sees the rest of the case workspace instead of being denied the page outright.

### Negative

- The back office lost its Tickets and Conversations pages as separate concepts; anyone who had bookmarked `tickets/<id>` or `threads/<id>` relies on `lib/backoffice/legacy-routes.ts` firing the redirect correctly rather than the URL still existing on its own.
- Voice and video escalation remains unbuilt, so a case that genuinely needs a call still has to be handled outside this workspace until #1849 is decided and built.

## References

- #1527 — the umbrella audit this round closes a slice of.
- PR #1842 — the implementation, landed across `dec787d1e`, `2be8c69fd`, `54cbabb31` and `f4b5d9117`.
- `lib/support/case-key.ts` — the `t_`/`s_`/`b_` case-key format.
- `lib/backoffice/legacy-routes.ts` — the redirect mapping for the retired Tickets and Conversations URLs.
- [docs/support/01-architecture.md](../support/01-architecture.md) — the underlying two-scope, one-engine support architecture this ADR builds a workspace on top of.
- [Engineering log: the dashboard overhaul](../dashboard/engineering-log-2026-09-27-dashboard-overhaul.md) — Round 5.
