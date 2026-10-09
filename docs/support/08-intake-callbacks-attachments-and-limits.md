# Intake, callbacks, receipts, attachments and rate limits

This page covers what happens around a ticket rather than inside its lifecycle: how a customer's request becomes a ticket, how a callback number is accepted and trusted, who may escalate to engineering, what the requester is sent, how attachments are stored and served, and which routes spend which rate-limit budget. The lifecycle itself is in [07-ticket-lifecycle-and-concurrency.md](07-ticket-lifecycle-and-concurrency.md) and the clocks are in [03-ticket-references-and-sla.md](03-ticket-references-and-sla.md).

## How a request becomes a ticket

There are three doors, and all of them end in the same factory rules: a reference from `allocateTicketReference`, SLA deadlines from `slaDeadlinesFor`, and `lastMessageAt` set to the creation time, all inside one transaction.

- **The ticket form** (`POST /api/user/support-tickets`) validates the body with `CreateSupportTicketSchema`, refuses issue types that belong to a specific session with a 422 and the code `SESSION_SCOPED_ISSUE` (the customer is told to open the appointment and use "Get help"), resolves any linked booking, payment or organisation against the caller's own records, and reuses a still-open ticket for the same payment instead of filing a twin.
- **The platform bot** (`POST /api/support/platform`) is stateless until its terminal turn. Only an escalating terminal writes, through `createSupportTicket`, and a replayed terminal reuses the user's own `OPEN` ticket for the same outcome within thirty minutes.
- **The booking bot** (`POST /api/appointments/[appointmentId]/support`) escalates a persisted thread. The ticket description is a structured brief built by `escalationBrief`: the customer's last substantive message (a bare "agent" or "talk to a human" does not count), the topic, the flow path, what the bot last said, and the escalation reason. A customer who typed only the trigger word therefore does not become a ticket whose description is that word; the brief falls back to the earlier substantive turn and then to the chosen option's label.

Malformed JSON on the ticket and response routes is a 400 through the same Zod path as any other invalid body, not a 500. Validation failures on the ticket, reply and product-feedback (`POST /api/user/feedbacks`) routes answer the support error envelope `{ error, code, detail? }` with the code `VALIDATION_FAILED` and a Zod `flatten()` detail, never the raw issue list. The client keeps only the first message per field (`fieldErrorsOf` in `lib/support/error-copy.ts`) to show inline, for example under the callback phone input. A 5xx never echoes `detail` to the client; it goes to Sentry only.

A ticket created from the form shows a success toast titled "Request FAM-… created" whose description is the reply-by time computed from the ticket's `ackDueAt` (`describeWait`), for example "Our team will reply by 4:30 PM today." When the deadline has already passed, the copy says the team is taking longer than usual instead of repeating a lapsed promise.

A customer can flag a bot hand-off as urgent with the "This is urgent" checkbox on the escalation step of the booking bot and on the platform bot's "Talk to a person" step. The turn then carries `urgent: true`, and `escalationPriority` files the ticket at `HIGH`; without the flag the reason-to-priority map decides, so an urgent request is never silently filed as `MEDIUM`.

The human exit is one tap away in every bot state. The platform sheet shows a "Talk to a person" button under every prompt unless the current options already include one, and the booking bot shows its human-contact option (the `OTHER` intent) beside the current options until the conversation is with a person or closed. A customer who types only a bare request for a human is routed to the same escalation step rather than sent as a message.

When a ticket is `RESOLVED`, both the request page and the booking conversation show "This request is marked resolved. Replying reopens it." above the reply box, and the request page's placeholder changes to "Reply to reopen this request…".

## Callback requests

A customer can ask for a call back when they create a ticket. The phone number is untrusted input, so two rules hold.

**The number is validated on the server.** `callbackPhoneSchema` in `lib/validation/phone.ts` accepts an Indian mobile (with an optional `+91`, `91` or `0` prefix, starting 6 to 9) or an international E.164 number, strips spaces, brackets and hyphens, rejects a run of ten or more identical digits, and canonicalises the result. The form's `callbackPhone` field goes through it, and the factory writes only the canonical value.

**Only the server can write the marker.** A callback ticket's description begins with `[Callback Requested: <phone>]`, and `createSupportTicket` is the only code that prepends it. Every customer-supplied string that reaches a description or a reply (the form description, replies, bot messages) passes through `stripCallbackTags`, which removes every case-insensitive marker and repeats until none can re-form. On the read side `extractCallbackInfo` honours the marker only at the very start of the description and only when its contents re-validate as a phone number; a marker typed anywhere else is ordinary text. So a customer typing the tag into a low-priority ticket gets neither the callback badge nor a dialable link in the staff panel, and the staff `tel:` link is built from digits and `+` only. The staff "create for a user" path (`createOutboundStaffSupportTicket`) strips the marker from the description it stores and from the first message it sends, because staff free text never carries a callback request either.

## Escalating to engineering

The staff case panel has an "Escalate to Engineering" link, shown only where the viewer holds the `engineering.escalate` permission, which `BACKOFFICE_PERMISSIONS` grants to `ADMIN` alone; staff keep every other ticket permission. The link opens a pre-filled issue on the repository's issue tracker, which is public, so `buildEngineeringEscalationHref` writes only the case key and the ticket reference into the body and tells the author not to add customer personal data. Nothing about the person, the booking or the payment is pre-filled.

## What the requester is sent

Creating a ticket stages two things. Staff are notified through `notifySupportStaff`. The requester gets an intake receipt from `notifyRequesterOfTicket`: an in-app bell through the `SUPPORT_TICKET_RECEIVED` workflow (outbox-staged with the dedupe key `ticket-received:<ticketId>`) and an email through `sendSupportTicketReceivedEmail`, both carrying the `FAM-` reference, the title and the acknowledgement window the ticket was actually given (for example "24 hours"), computed from `ackDueAt` and not from a constant. The receipt deliberately does not set `acknowledgedAt`: an automated receipt is not a human reply, and the acknowledgement clock must keep running until staff answer. Only a ticket the requester filed themselves earns a receipt. `createSupportTicket` requires a `filedBy` value: the form and the platform bot pass `"requester"`, whereas the no-show cron's both-absent ticket passes `"system"` and sends staff the notification only. The booking bot escalates inside its own transaction and sends the receipt itself, always, since the customer asked for the hand-off. A receipt that fails is logged and never fails the create, because the ticket is already committed and a retrying client would file a duplicate.

Later events notify the other way. A staff public reply and a staff status change each tell the customer, with the reference leading the title, and a customer reply tells the assignee, or the staff roster when nobody is assigned, through `notifyStaffOfTicketActivity`.

## Rate limits

Ticket creation, replies, session ratings and reports use `spamLimiter`, which allows five requests per hour per identifier, so each prefix below is its own bucket of five per user per hour. Attachment churn is a different shape of traffic and uses `documentUploadLimiter` (ten per minute, the same limiter definition as booking-document uploads but a separate counter), keyed per user and per ticket, and it is never charged to staff, who work across many cases. Charging a route spends only that route's bucket.

| Route                                                 | Identifier                                                                | Charged when                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `POST /api/user/support-tickets`                      | `tickets:<userId>`                                                        | After authentication, before the body is parsed                                 |
| `POST /api/user/feedbacks`                            | `feedbacks:<userId>`                                                      | After authentication, before the body is parsed                                 |
| `POST /api/support/platform`                          | `tickets:<userId>` (shared)                                               | Only on an escalating terminal turn; navigation turns are free                  |
| `POST /api/user/support-tickets/[ticketId]/responses` | `ticket-response:<userId>`                                                | After authentication, before the body is parsed                                 |
| `POST /api/support-tickets/[ticketId]/attachments`    | `ticket-attachment-upload:<userId>:<ticketId>` on `documentUploadLimiter` | After the access, closed-ticket and five-attachment checks pass; customers only |
| `DELETE /api/support-tickets/[ticketId]/attachments`  | `ticket-attachment-delete:<userId>:<ticketId>` on `documentUploadLimiter` | After the ownership and closed-ticket checks pass; customers only               |
| `POST /api/appointments/[appointmentId]/support`      | none                                                                      | Booking-bot turns spend no limiter; the ticket budget is not touched            |
| `POST /api/appointments/[appointmentId]/feedback`     | `appointment-feedback:<userId>`                                           | Session rating writes                                                           |
| `POST /api/report`                                    | `report:<userId>`                                                         | Moderation reports                                                              |

The platform bot and the ticket form share the `tickets:` bucket on purpose, because both file a ticket. Navigating a flowchart must never spend the budget that filing a ticket needs. The access, closed-ticket and attachment-cap checks run before the limiter, so a sixth upload reads "Maximum 5 attachments allowed per ticket" rather than a rate-limit error. A limiter that cannot reach its store fails open and reports once to Sentry, so a Redis outage does not stop customers from reaching support.

A 429 carries `retryAfterSeconds` and the `Retry-After` header, and the client copy in `lib/support/error-copy.ts` renders the real wait ("try again in 54 minutes") instead of a vague promise.

## Attachments

Attachments live in the private `support-attachments` bucket, and storage operations run on the server client. A row's stored `fileUrl` is never handed out; every read goes through an access-checked app route.

- **Upload** (`POST …/attachments`) is allowed to the ticket owner and to staff, refused on a `CLOSED` ticket, capped at five per ticket, limited to 10 MB and a fixed allow-list of document and image types, and stored under `support-tickets/<ticketId>/`. Every upload failure (type, size or storage) answers a 400 with one generic sentence telling the customer which file types and size are accepted; the underlying storage message is reported once to Sentry and never reaches the client. The row insert runs under a `SELECT … FOR UPDATE` on the ticket so concurrent uploads cannot exceed the cap; if the insert fails or the cap is lost, the object just written is removed.
- **Read** (`GET …/attachments/[attachmentId]`) authorises the owner or staff, signs a URL valid for 60 seconds, and answers a 302 redirect with `Cache-Control: private, no-store`. Anonymous callers get 401 and other customers 403. Signed URLs cannot be revoked, which is why the lifetime is short. Listings return the app-route URL for every row, including rows written before the bucket was private.
- **Delete** (`DELETE …/attachments`) removes the object first and the row second. `removeObjects` treats a delete as successful only when every path is gone afterwards: storage answers a batch delete with just the objects it removed, so each path missing from that answer is re-checked with an existence call. If the object may survive, the route reports once to Sentry, answers 502 "Could not delete the file", and leaves the row so the delete can be retried. A silent 200 over a surviving object is not possible.

The same server-client helpers back the other private-bucket features, such as plan materials and appointment documents; see the [storage strategy](../storage/management-strategy.md#server-client-operations-and-private-buckets).

## Deprecated & Superseded Approaches

- **A public attachments bucket with stored public URLs**: superseded by the private bucket and the signed-redirect route above. Rows written before the change still hold the old URL in the database, which is why every read path maps the stored value to the app route; do not render `fileUrl` from a raw row.
- **Delete helpers that ignored their result**: the attachment, plan-material and upload-rollback deletes used to report success without checking. Superseded by `removeObjects` returning a verified boolean that callers act on.
- **A callback tag parsed from anywhere in the description**: superseded by the start-of-description, re-validated marker. Do not reintroduce a regex that scans the whole body.
- **One shared 429 sentence for every limiter**: replaced by the real `retryAfterSeconds`. Do not hard-code a wait in client copy.
- **Charging the ticket budget on every bot turn**: the booking bot no longer spends the limiter at all, and the platform bot spends it only on its escalating terminal.
