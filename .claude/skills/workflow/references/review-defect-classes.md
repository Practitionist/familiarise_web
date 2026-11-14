# Review defect classes

This is the catalogue the `independent-reviewer` agent hunts through, and a checklist for any reviewer of money, state or access code. Each class gives the pattern in one sentence, where it bites in the current code, and a concrete way to look for it in a diff.

**Keep it current.** A builder who fixes a review finding that fits none of the classes below adds a new class here in the same pull request, in the same three parts. The reviewer's report ends with a "Defect class to record" section for exactly this.

## a. A grant written before its safety re-check can read what it needs

**Pattern.** A write that grants access runs before the reads its re-check depends on, so a failed read leaves the grant in place and unchecked.

**Where it bites now.** `grantEventChannelMember` in `lib/stream/event-channel-service.ts` adds a chat member that `fenceSeatGrants` (`lib/stream/access-revocation.ts`) must be able to take back. The fence is keyed by the event's appointment, so that appointment is read before any member is added, and a failed read returns `member_not_added` with nothing written.

**How to look for it.** For each grant write in the diff (`addMembers`, `upsertUsers`, a seat or role insert), list every value its re-check reads, and ask: is each one read before the write, and does a failed read stop the write? `git diff origin/dev...HEAD -- lib/stream | grep -nE 'addMembers|fenceSeatGrants|finally'` finds the writes and the fences to compare.

## b. An exception between a write and its re-check skips the re-check

**Pattern.** An `await` that can throw sits between a write and the re-check that guards it, so the re-check never runs on that path. The re-check must cover every write that completed before the exception, including writes from earlier iterations of a loop, not just the last one.

**Where it bites now.** `ensureChannelsForAppointment` in `lib/payments/webhooks/ensure-channels.ts` adds each buyer to the event chat in a loop, and `createDirectMessageChannel` can throw `DmNotPermittedError` partway through. Its `finally` runs `fenceSeatGrants` over every buyer the loop had granted so far (`granted.userIds` together with the roster read), so an early throw still takes back every completed grant.

**How to look for it.** For each write in the diff, list every `await` between it and its re-check and ask which of them can throw (a vendor call, a typed refusal, a timeout). Then ask whether the re-check runs in a `finally`, and whether it reads an accumulated list of what was written rather than only the current item. A re-check inside the loop body, or after the loop without a `finally`, is the defect.

## c. One shared function fed by several readers, one of which does not select what it needs

**Pattern.** A function that decides a status, a label or a permission is called from several screens, and one screen's Prisma `select` omits a field the function reads, which then arrives as `undefined` and reads as "no", with no compile error.

**Where it bites now.** `appointmentStatusChip` in `lib/appointments/occurrences.ts` and the money state in `lib/dashboard/money-state.ts` read view models built by `mapConsultantAppointments` (`lib/appointments/map-consultant.ts`), `mapConsulteeEvents` (`lib/appointments/map-consultee.ts`) and `mapAppointmentDetail` (`lib/appointments/map-detail.ts`). Each mapper is fed by its own reader, such as `lib/data/consultant-appointments.ts`.

**How to look for it.** When the diff makes a shared function read a new field, list every caller (`git grep -n '<functionName>(' -- lib app components`), follow each one back to its reader, and check that the reader's `select` names the field. A field added to one reader's `select` but not to the others is the defect.

## d. A control that sends a shape or a unit the route rejects

**Pattern.** A button, picker or form sends a value whose shape or unit the route's zod schema or its own precondition check does not accept, so the action fails for real users while each side's tests pass. Typical mismatches are sessions against half-hour slots, rupees against paise, and local time against UTC.

**Where it bites now.** The Requests inbox computes `tentativeSlotCount` in `lib/data/requests-inbox.ts`. The approval posts it as `expectedTentativeSlotCount` (`components/dashboard/shared/requests/request-decision.ts`), and the allocator re-asserts it against the tentative rows it counts in `assertExpectedTentativeSlotCountInTx` (`lib/booking/allocation/guards.ts`). Both sides count rows. The inbox's own approvable check compares half-hours with half-hours in `lib/dashboard/requests-inbox-state.ts`.

**How to look for it.** For every control the diff touches, write down the exact body it sends and run it through the route's zod schema and its precondition guards in a contract test. Ask of every number: what unit does the sender count in, and what unit does the receiver count in?

## e. A fix proven only against mocks or hand-built input

**Pattern.** A test feeds the fixed function an object the test author wrote by hand, so it proves the function but not the screen, which only ever receives what its reader's `select` returns.

**Where it bites now.** The mappers in class c are tested in `__tests__/` suites that call `mapConsultantAppointments`, `mapConsulteeEvents` and `mapAppointmentDetail`. A test that builds their input by hand passes even when the real reader in `lib/data/` never selects the field the fix depends on.

**How to look for it.** For each test the diff adds, ask where its input comes from. `git diff origin/dev...HEAD -- __tests__ | grep -nE 'mockResolvedValue|as unknown as'` shows hand-made returns. A state fix needs at least one test whose input is shaped by the real reader's `select`, or a preview case listed as not verified.

## f. A status transition that reads and then updates instead of comparing in the WHERE

**Pattern.** A status write on a `Payment`, `Appointment`, `Refund` or `Payout` is a `findUnique` followed by an `update` keyed by id, so a concurrent writer's status is overwritten. It must be an `updateMany` whose `where` names the expected prior status, followed by a check of `count`.

**Where it bites now.** The overage side-charge handlers in `lib/payments/webhooks/overage-handlers.ts` do it the right way: `handleOverageMemberFailure` moves a payment to `FAILED` only from `PENDING`, and returns before any side effect when `count` is zero. A capture that lands first therefore keeps `SUCCEEDED`.

**How to look for it.** `git diff origin/dev...HEAD | grep -nE '\.(update|upsert)\(\{' ` and, for each hit on one of the four models, ask whether the `where` holds the prior status and whether `count === 0` is handled before anything else happens.

## g. A helper inside `prisma.$transaction` that uses the global client

**Pattern.** A helper called from a `$transaction` callback queries the global `prisma`, which deadlocks under `PG_POOL_MAX=1` on Netlify, because the open transaction holds the only connection. A local dev server has a bigger pool and never shows it.

**Where it bites now.** `checkConsent` in `lib/compliance/dpdp.ts` takes the client as a parameter (`db = prisma`) because slot validation calls it inside the checkout transaction. `__tests__/payments/checkout-pool-1-nesting.test.ts` pins this with a global client that throws while a transaction is open.

**How to look for it.** For each function the diff calls from inside a `$transaction` callback, follow it down and check that every query runs on the `tx` it was handed. `git diff origin/dev...HEAD | grep -nE '^\+.*\bprisma\.'` lists new global-client calls to check against the transactions they sit under.

## h. A lock wait or a retry that lets a request skip a consent or freshness check

**Pattern.** A check that depends on the clock or on another party's state (a notice period, a pay window, a consent, an open status) runs before a lock wait, a Serializable retry or a long await, so it can be stale when the write commits. It must be re-decided inside the transaction that writes.

**Where it bites now.** `tryAutoConfirmProposal` in `lib/booking/reschedule-auto-confirm.ts` reads the proposal and checks that it is `PENDING_REVIEW` before `withAppointmentLock`. That status is re-decided inside the allocation transaction's `inTx` callback by `closeConfirmedProposal` (`lib/booking/reschedule-confirm.ts`), which only moves a proposal from `PENDING_REVIEW`. Any rule added before the lock needs the same re-decision inside `inTx`.

**How to look for it.** For each guard the diff adds, ask whether its inputs can change between the check and the write's commit (the clock, the other party's answer, a row another request can move). If they can, look for the same decision inside the transaction's callback, and for a test that changes the input during the lock wait.
