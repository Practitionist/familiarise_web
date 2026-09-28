# Forms

The onboarding wizard is a five-step form with a server round-trip per step. Two
bug classes showed up repeatedly and are worth knowing by name.

---

## Validation timing: split by field, not per form

`react-hook-form` has one `mode` per form, but the onboarding steps hold fields
with opposite timing needs:

- **Short, structural fields** (name, phone, URL) — `onChange`. The user is
  typing, and immediate feedback is what they want.
- **Long free text** (address lines, notes) — `onBlur`. Validating a half-typed
  address on every keystroke is hostile, and the errors are not actionable until
  they have finished the thought.

`PersonalInfoAndRoleForm` uses `mode: "onTouched"` for exactly this reason.

**Know what `onTouched` actually does, because it is not the same as
`onBlur`.** In v7 the sequence is:

1. While the field is untouched, validation waits for the **first blur**.
2. Once the field is touched, it falls through to `reValidateMode`, which
   **defaults to `onChange`** — so every subsequent keystroke validates again.

So `onTouched` only buys you the run-up to the first blur. After that it behaves
like `onChange` for that field. If you genuinely want "validate when the user
leaves the field, and stay quiet while they go back and fix it", that is
`mode: "onBlur"` — or give the long field its own sub-form so the modes can
differ. Do not reach for `onTouched` expecting `onBlur` behaviour.

`ConsultantProfileForm` is the counter-example to watch for: it is `onChange`
and holds long free-text fields, so it revalidates an unfinished bio on every
keystroke. If that ever gets reported as noise, the fix is a sub-form, not a
softer message.

Validate on **blur and on submit**, never on `submit` alone. A user who never
blurs a field should still get errors when they try to advance.

---

## Never advance the wizard from a stale validation result

This is the **double-advance bug class**, and it is the most serious thing in
this file.

The failure: the "Next" handler read a validation result computed _before_ the
current keystroke settled, found it clean, and advanced. Typing fast and hitting
Next moved you forward with a field that was not actually valid.

The rule:

> **Validate at the moment of the transition, inside the transition handler, on
> the values as they are right now.** Never trust a validation result captured by
> an earlier render, a memo, or a state flag that a sibling update already
> invalidated.

If the guard needs to know whether validation passed, it has to call validation
itself and read that result — not read something a previous render left behind.

`__tests__/onboarding/onboarding-shell-contract.test.ts` locks this in, so
regressions fail in CI rather than in a user's session.

---

## Server refusals are typed and must be shown

`OnboardingRefusedError` carries a `code`, a `message`, and the `field` it
belongs to. A refusal is not a generic failure — it is a validation result from
a source the client cannot see, and it must be routed to that field.

Two rules follow:

1. **Never swallow a refusal into a toast.** Map it to the field and show it
   inline, so the user can fix it where they are looking.
2. **Never show the raw `message` as generic text.** It is written for a field
   and reads as noise at the top of a form.

The wizard has a transition guard on top of this: a refusal must not leave the
step in a state where advancing is still allowed.

---

## The write boundary is authoritative

The wizard validates with `OnboardingFormDataSchema.safeParse` and _then_ the
server validates again with `validateOnboardingData`. That duplication is
intentional. The client copy exists to be fast and to place errors; the server
copy is the one that counts.

Never relax a server schema to match a client that is easier to satisfy. See
[01-server-data-and-validation.md](./01-server-data-and-validation.md).

---

## Uncontrolled vs controlled

Fields backed by server state — an email from the session, a role already chosen
— render `readOnly`, not `disabled`. A `disabled` field is not submitted, so
"disabled until step 3" silently drops the value on step 2. The same reasoning
applies to role selection: it is a `<fieldset>` with radio inputs so the group
label and its error message are programmatically associated, not a `<div>` of
clickable divs.
