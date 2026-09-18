# Engineering log — 2026-09-18 — Prisma validates the whole create against one input shape

**Date:** 2026-09-18 · **PR:** #1702 (recorded here as part of #1703) · **Scope:** `utils/scheduling-engine/SchedulingService.ts` `createAppointments`, the allocation tests under `__tests__/booking-algorithm/`.

## What broke

Every allocation of an unpaid request threw `Unknown argument cancellationPolicyId` on a live preview (Sentry FAMILIARISE_WEB-4F). The path is the one that deletes the unpaid wrapper and creates a fresh `Appointment`, and the create mixed two styles in a single `data` object: the event relation was written as `[relationField]: { connect: { id } }` while the cancellation policy and the funding organisation were written as the scalar foreign keys `cancellationPolicyId` and `organizationId`. An earlier commit had only omitted the policy key when it was null, which hid the policy-less case and left a consultant with a policy, or any org-funded booking, failing exactly as before.

## Why it broke

Prisma generates two create inputs per model. `AppointmentCreateInput` is the checked shape: relations are written through `connect`, `create` and friends, and it carries no `*Id` scalar fields at all. `AppointmentUncheckedCreateInput` is the scalar shape: every foreign key is a plain `*Id` field and there are no relation objects. The two are a union on `create({ data })`, and Prisma picks which member to validate against from the keys it sees. One relation-style key is enough to select the checked shape, at which point every scalar foreign key beside it is an unknown argument. The error message names whichever scalar it meets first, which is why it blamed `cancellationPolicyId` and why nulling that one key looked like a fix.

The trap is that `tsc` does not catch it. The union type accepts the object because each key is valid in one of the two members; only the runtime validator, which insists on a single member, refuses it. Jest with a mocked `tx.appointment.create` never runs that validator either, so the tests were green while the preview was red.

## The rule

A single `data` object is either all relation objects or all scalar foreign keys. Checkout already wrote the scalar form, so `createAppointments` now writes `[`${relationField}Id`]: eventId`, `organizationId: organizationId ?? null` and `cancellationPolicyId: inheritedPolicyId` with no `connect` anywhere in the object; `NULL` is the platform-ladder value for the policy and is legal again. The pin in `__tests__/booking-algorithm/schedulingService.test.ts` asserts that no key in the create's `data` is an object carrying `connect`, that a non-null policy id survives, and that an org-funded allocation writes `organizationId` as a scalar.

## What to look for elsewhere

Any `create` or `update` whose `data` is assembled from two sources is a candidate: one source spreading a relation `connect`, the other adding a scalar id. The review question is simply whether the object could ever contain both a `connect` and an `*Id` key at once. Prefer the unchecked scalar form wherever the id is already in hand, because it composes with spreads without changing which input shape Prisma validates against.

## Related follow-up (not built here)

`createAppointments` reads `inheritedPolicyId` from the originating wrapper after `deleteExistingAppointments` has already removed an unpaid one, so inheritance is `NULL` on that path. It is harmless today because request-submitted wrappers carry no policy, and it is recorded for PR-C of #1703 rather than fixed in this PR.
