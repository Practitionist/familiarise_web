# Refusals: typed answers that are not faults

**Status:** implemented · **Code:** `lib/errors/refusal.ts`, `lib/errors/action-result.ts`, `lib/errors/client-refusal.ts`, `lib/errors/api-error.ts` · **Pin:** `__tests__/errors/refusal-rails.test.ts`

## What a refusal is

A refusal is an outcome the code anticipated and is answering on purpose: the caller has no session, the caller does not own the calendar they asked about, the reschedule window has closed, the occurrence being rated is not part of this booking. None of those is a fault, yet until this rail existed most of them were thrown as plain `Error`s, and a thrown `Error` has exactly one audience. On the server it was captured by Next's `onRequestError` hook or by a route's catch-all and became a Sentry issue at error level; in the browser it was put into a toast verbatim, ids and all, and captured a second time. The finance doctrine already states that business-coded refusals must never surface as 500s; `Refusal` is that rule generalised to every subsystem.

A `Refusal` is an `Error` subclass that carries two messages for two audiences. `userMessage` is the sentence a toast shows, written for the person in front of the screen and free of identifiers. `devMessage` is the Error's `message`, the sentence Sentry and the server logs get, and it may name ids and internals. It also carries a stable machine-readable `code` that a client can branch on regardless of rewording, an `httpStatus` that a route answers with (401 unauthenticated, 403 forbidden, 404 not found, 409 conflict or state, 422 invalid input; the default is 409), and an optional `context` bag of ids for the log line. The constructor takes one object, and `devMessage` defaults to `userMessage`, so the common case is a single call:

```ts
throw new Refusal({
  code: "NOT_OWNER",
  httpStatus: 403,
  userMessage: "Only this consultant can see their appointment details.",
  devMessage: "Forbidden: appointment details require consultant ownership",
  context: { consultantId, userId },
});
```

`isRefusal(error)` is the type guard, and `RefusalShape` is the wire format `{ code, message }`, where `message` is the user's sentence and nothing else.

## How a route answers one

A route hands a `Refusal` to `apiError`, either by constructing it inline or by letting a `Refusal` subclass such as `ReschedulePolicyError` propagate to the catch block and checking `isRefusal(error)` first. `apiError` then writes one `console.warn` line with the tag, the code and the developer message, answers `{ error: userMessage, errorType: code, code }` with the refusal's `httpStatus`, and does not capture anything. The only exception is a refusal whose status is 500 or above, which is recorded through `reportSentryError` as an expected `info` event with the code as a tag and the context bag attached; a 4xx is an answer and never reaches Sentry. Every other branch of `apiError`, the `BUSINESS_ERROR_CODES` registry and the message-pattern classifier, is unchanged, so an existing route that throws a coded `Error` keeps working exactly as before.

## How a server action answers one

A server action cannot throw a refusal, because anything a `"use server"` function throws is captured by `onRequestError` before the caller sees it. Actions return an `ActionResult<T>` instead, which is either `{ ok: true, data }` or `{ ok: false, refusal: RefusalShape }`, built with `okResult(data)` and `refusalResult(refusal)`. The Stream token actions are the first to use it: an expired cookie now comes back as `{ ok: false, refusal: { code: "UNAUTHENTICATED", message: "Please sign in again to continue." } }` and the provider stops connecting, shows the sentence, and neither retries nor reports. The channel-sync action keeps its existing `{ success, skipped, error }` shape and gains an optional `refusal` field on the failure branch for the same reason.

## How the client shows one

The browser half lives in `lib/errors/client-refusal.ts`. `userMessageFrom(error, fallback?)` returns the sentence a toast should show for any of the three shapes a refusal travels in: an `ApiResponseError` from `requireJsonResponse` (its `message` is already the body's `error`, and `detail.error` is preferred when present), a `Refusal` thrown locally, or an `ActionResult` with `ok: false`. Anything else gets the generic fallback, never the raw text of an unknown error. `isExpectedRefusal(error)` is true for the same three shapes, with an `ApiResponseError` counting only when its status is a 4xx, and every client-side capture on a converted page is gated on it so that a refusal is shown and not reported. `refusalFromShape(shape)` rehydrates a wire refusal into a `Refusal` so client code can throw and match on it.

## Where a refusal's title and words live

A refusal toast has a title that names the problem and a body that says what to do next. The body is usually the server's own sentence (the refusal's `userMessage`), because the server knows the facts that make it specific: the deadline, the count, the amount. The title is chosen on the client from the refusal's `code`, in one table: `TYPED_CODE_TOAST_MAP` in `lib/errors/mapping/payment-error-toast-map.ts`, read through `codedRefusalToast(code, serverSentence, fallbackTitle)`. A code the table does not list keeps the caller's own title, which names the action that failed ("Couldn't request a reschedule"). Checkout's coarse error types keep their titles in `ERROR_TOAST_MAP` in the same file, read through `getErrorToast`. Every title is sentence case with no trailing "!", and no toast is titled "Error" or "Not done"; `__tests__/errors/refusal-titles.test.ts` fails if one comes back.

For example, an expert's third reschedule of one booking answers 409 `EXPERT_RESCHEDULE_CAP`. The toast is titled "No reschedules left on this booking", and its body is the server's sentence, which says to cancel instead, that the client is refunded in full, and that the cancellation is recorded on the expert's reliability record. A class make-up refused with `MAKEUP_WINDOW_LAPSED` has one sentence for each of its five conditions, and the deadline one names the date in the viewer's zone, 14 days after the session was cancelled (`makeUpWindowRefusal` in `lib/booking/class-sessions.ts`).

The code and the HTTP status of a refusal never change when its words do. A client branches on the code, so a copy change is safe for every caller.

## What is deliberately not on the rail

Money refusals keep their own classes. `RefundError`, `RefundGatewayError` and `RefundValidationError` are modelled outcomes that still need a human, so where a route or a moderation job records one for follow-up it now reports it through `reportSentryError` as expected at `warning` rather than as an unexpected error, and the durable `recordSystemError` row is unchanged. Their throw sites and the money logic are untouched. Similarly, a genuine failure is still a failure: a 504 from a Novu trigger, a network error during checkout, or a 5xx from any route is captured exactly as before.

## Deprecated & Superseded Approaches

1. **"Error" as a toast title.** Thirty-eight catch blocks titled their toast "Error" and some back-office doors "Not done", so a person read the problem only in the body. Each now names what failed, and coded refusals take their title from the table above.
2. **Title Case checkout titles.** The checkout table read "No Free Time In The First Week"; it is sentence case now.
