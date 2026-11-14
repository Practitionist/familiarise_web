# Review defect classes

This is the catalogue the `independent-reviewer` agent hunts through, and a checklist for any reviewer of money, state or access code. Each class has a one-line test (how to look for it) and one real example from this repository, verified in the code or in the named pull request.

**Keep it current.** A builder who fixes a review finding that fits none of the classes below adds a new class here in the same pull request, with its test and that finding as the example. The reviewer's report ends with a "Defect class to record" section for exactly this.

## a. A grant written before its safety re-check can read what it needs

**How to look for it.** For every write that grants access (a chat member, a call member, a seat, a role), find the re-check that can take it back, and list what that re-check reads. If any of those reads runs after the grant, a failed read leaves the grant in place and unchecked.

**Example.** Pull request #2753 ("fix(stream): a departed or removed attendee is not re-added to the event chat when someone else registers"), `lib/stream/event-channel-service.ts`. The existing-channel join added the member first and looked up the event's appointment (which owns the seats and keys the revocation intent) inside the `finally`. When that lookup timed out, the catch only logged, the join still returned success, and `fenceSeatGrants` never ran, so a learner whose seat had just ended kept the chat grant. Commit `1d069c1ce` moved the lookup into `grantEventChannelMember` before any write, and a failed lookup now writes nothing.

## b. An await that can throw between a write and its re-check

**How to look for it.** Between a write and the re-check that guards it, list every `await`. If any of them can throw (a vendor call, a typed refusal, a timeout), the re-check is skipped on that path. A `finally` around the writes, or the re-check before the throwing call, fixes it.

**Example.** The same pull request, `lib/payments/webhooks/ensure-channels.ts`. The registration sync adds each buyer to the event chat and then opens a direct-message channel with the host; `createDirectMessageChannel` throws `DmNotPermittedError` when that was the pair's only eligible booking. The seat fence ran after the loop, so the throw skipped it and a learner who left mid-sync stayed in the chat. Commit `dcc77b338` runs `fenceSeatGrants` in a `finally`.

## c. One shared function fed by several screens' queries, one of which does not select what it needs

**How to look for it.** For a function that decides a status, a label or a permission and has several callers, list every caller's Prisma `select` and check that each one selects every field the function reads. A missing field usually reads as `undefined`, which the function treats as "no", and nothing fails to compile.

**Example.** Pull request #2750 ("feat(booking): one status vocabulary, the appointment detail page and expert demand guidance (#2720 train 1)"). The status function `bookingStatus` (lib/appointments/booking-status.ts on that branch) is fed by the detail page, both participants' lists, the expert home and the organisation pages. The expert home and the organisation detail passed no booking source and no open reschedule, so a pay-first hold and a booking being moved read wrongly there (commit `73632833f`), and the expert's list read in `lib/data/consultant-appointments.ts` selected no payment rows, so a live pay-first hold read Cancelled (commit `c26337c4b`).

## d. A control that sends a shape or a unit the route rejects

**How to look for it.** For every button, picker or form a change touches, write down exactly what it sends and run it through the route's zod schema and the route's own precondition checks. Units are the usual mismatch: sessions against half-hour slots, rupees against paise, local time against UTC.

**Example.** Pull request #2746 ("feat(booking): one target lifecycle per product — request mode enforced, dead states removed"), the Requests inbox Approve. The inbox's `tentativeSlotCount` (`lib/data/requests-inbox.ts`) is also the `expectedTentativeSlotCount` the approval posts (`components/dashboard/shared/requests/request-decision.ts`), and the allocate route re-asserts it against the tentative rows it counts (`lib/booking/allocation/guards.ts`). Counting it in half-hours made a 60-minute approval fail with "expected 2, found 1". Commit `6375db3b5` posts rows again and compares half-hours with half-hours only in the inbox's own check (`lib/dashboard/requests-inbox-state.ts`).

## e. A fix proven only against mocks, which fails on the real reader output

**How to look for it.** For each test the fix adds, ask where its input comes from. A hand-built object or a mock that returns whatever the test wants proves the function, not the screen; the screen gets only what its reader's `select` returns. Look for a test that feeds the real reader's projected output.

**Example.** Pull request #2750 again. Commit `85f71b1c5` made a pay-first hold read "Awaiting payment" with a working Pay action and was tested through a hand-built detail input. On the expert's list the same hold still read Cancelled, because that reader selected no payment rows. Commit `c26337c4b` added a test fixture, `projectRow`, that projects one stored row through each real reader's `select`, so a mapper that reads an unselected field fails its test.

## f. A status transition that reads and then updates instead of comparing in the WHERE

**How to look for it.** Every write to the status of a `Payment`, `Appointment`, `Refund` or `Payout` must be an `updateMany` whose `where` names the expected prior status, followed by a check of `count`. A `findUnique` then `update`, or an `update` keyed by id alone, lets a concurrent writer's status be overwritten.

**Example.** `lib/payments/webhooks/overage-handlers.ts`, commit `38ae2d2ee` ("fix(overage): ... the side-charge status writes are CAS"). A `payment.failed` delivery that committed after the capture transaction overwrote `SUCCEEDED` with `FAILED`, leaving the overage charged and the organisation credit posted against a payment that read as failed. Both writes now carry the prior status in the WHERE: capture moves the status it read, failure moves only `PENDING`, and a zero count returns before any side effect.

## g. A helper inside `prisma.$transaction` that uses the global client

**How to look for it.** For every helper called from a `$transaction` callback, follow it down and check that each query runs on the `tx` it was handed. With `PG_POOL_MAX=1` on Netlify, the open transaction holds the only connection, so a read on the global `prisma` waits for a connection that cannot be released. A local dev server has a larger pool and never shows it.

**Example.** Pull request #1435 ("fix(payments): the checkout consent gate reads through the transaction, not the pool it is blocking"). `checkConsent` in `lib/compliance/dpdp.ts` read on the global client and was called from slot validation, which only runs inside the checkout transaction, so `POST /api/checkout` answered 500 "timeout exceeded when trying to connect" on every deploy. It now takes the client as a parameter (`db = prisma`) and the checkout passes `tx`; `__tests__/payments/checkout-pool-1-nesting.test.ts` pins it with a global client that throws while a transaction is open.

## h. A lock wait or a retry that lets a request skip a consent or freshness check

**How to look for it.** For every check that depends on the clock or on another party's state (a 24-hour notice, a pay window, a consent), find where it runs relative to the lock and the transaction. A check made before `withAppointmentLock`, a Serializable retry or a lock wait can be stale by the time the write commits; it must be re-decided inside the transaction.

**Example.** Pull request #2764 ("feat(booking): allocation and reschedule correctness, agreed short-notice moves (#2720 train 4)"), `lib/booking/reschedule-auto-confirm.ts`. `tryAutoConfirmProposal` decided whether a move needs the other side's acceptance before taking the appointment lock. A proposal 24 hours and one second away could cross inside 24 hours during the lock wait and still be recorded `AUTO_ACCEPTED`. Commit `a80f26ea7` re-decides `needsOtherSideAcceptance` inside the allocation transaction and refuses with `NEEDS_ACCEPTANCE`.
