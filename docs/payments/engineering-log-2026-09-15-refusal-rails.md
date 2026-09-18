# Typed refusal rails of 2026-09-15: every anticipated "no" becomes an answer

**Date:** 2026-09-15 · **Branch:** `fix/typed-refusal-rails` · **PR:** #TBD · **Scope:** `lib/errors/refusal.ts`, `lib/errors/action-result.ts`, `lib/errors/client-refusal.ts`, `lib/errors/api-error.ts`, and the nine sites below.

This entry records the rail described in `docs/errors/01-refusals.md` and the Sentry issues it was built against. The owner's framing was to build the rail and convert only the sites that leak today, with no new UI and no new features: every anticipated refusal becomes a typed `Refusal` with a developer message for Sentry and the logs and a user message for the toast. The rail is one class, one result type for server actions, two client helpers and one new branch in `apiError`; nothing existing in the classifier was changed.

## FAMILIARISE_WEB-13 and FAMILIARISE_WEB-10: the Stream token action threw "Unauthorized: sign in to request a Stream token"

`assertCanMintToken` in `actions/stream/chat/stream.action.ts` threw a marked-expected `Error` when the tab's cookie had expired, and because every throw from a server action is captured by `onRequestError`, it still produced 35 events at warning level on the consultant and consultee home pages. The guard now returns a `Refusal` (`UNAUTHENTICATED`, 401, "Please sign in again to continue."), and `tokenProvider` and `chatTokenProvider` return `ActionResult<string>` instead of a bare string. `providers/StreamProviderImpl.tsx` unwraps the result, keeps the refusal on a ref because the SDKs may wrap what a token provider throws, and when the connect fails on it, it sets a `not-retryable` failure whose description is the user's sentence and returns before the retry loop and before any capture. The `markExpected` marker is no longer needed at this site.

## FAMILIARISE_WEB-30 and FAMILIARISE_WEB-3M: the channel-sync action threw "Unauthorized: sign in to sync channels"

`syncUserEventChannels` in `actions/stream/chat/event-channel.action.ts` already reports every other failure by resolving with `{ success: false }`, so the unauthenticated guard now does the same and adds `refusal: RefusalShape` to that branch. The provider's fire-and-forget `.then` already handled a failed sync, and `InitializeUserChannelsButton` now reads `success` and shows the refusal's sentence rather than a success toast. The suite `__tests__/stream/event-channel-actions.test.ts` pins the returned refusal in place of the rejected promise.

## FAMILIARISE_WEB-3X: the consultation checkout page threw "Pick a time on the expert's profile…"

Both throw sites in `app/checkout/plans/consultation/[planId]/page.tsx` now throw a `Refusal` (`TIME_NOT_PICKED`, 422) whose message is unchanged, and `reportPaymentsError` in `app/checkout/plans/utils.ts`, which every checkout page and both gateway components share, returns early for anything `isExpectedRefusal` accepts. The page's existing display expressions were left as they were, because a `Refusal` whose developer message defaults to its user message renders correctly through them.

## FAMILIARISE_WEB-3Z: the allocate page reported the route's 403 "Forbidden: appointment details require consultant ownership"

`app/api/scheduling/availability-with-allocation/[consultantId]/route.ts` now answers that case through `apiError` with a `Refusal` (`NOT_OWNER`, 403) whose user sentence is "Only this consultant can see their appointment details." and whose developer message is the old string. `AllocationService.fetchAvailabilitySlots` throws an `ApiResponseError` carrying the status and code instead of an `Error` with a bolted-on `httpStatus`, and its catch only reports when the error is not an expected refusal. The calendar hook's toast reads `error.message`, which is the route's user sentence.

## FAMILIARISE_WEB-2Z: the reschedule page threw "Cannot reschedule within 24 hours of the session…"

`ReschedulePolicyError` in `utils/errors/RescheduleErrors.ts` now extends `Refusal` (`RESCHEDULE_WINDOW`, 409) and its sentence reads "Cannot reschedule within N hours of the meeting. The earliest meeting starts in M hours.", which retires the old vocabulary while keeping the wording. The reschedule route's catch answers any `Refusal` through `apiError` before its other branches, so the status moves from 400 to 409 and the body gains `code`; the two assertions in `__tests__/booking-algorithm/rescheduleCancel.test.ts` were updated to match. On the client, `reportActionFailure` in `components/appointments/consultee/useEventActions.ts` returns early for an expected refusal, and the consultant hook's reschedule handler, which had the identical leak against the same route, now parses through `requireJsonResponse` and gates its capture the same way.

## FAMILIARISE_WEB-35: the feedback route captured "[NOT_FOUND] That session isn't part of this booking…"

`app/api/appointments/[appointmentId]/feedback/route.ts` answered that case through `supportError`, which records every 4xx as a Sentry warning. It now answers through `apiError` with a `Refusal` (`OCCURRENCE_NOT_FOUND`, 404) whose sentence reads "That meeting isn't part of this booking, or it didn't take place", and nothing is captured. `SessionRatingRow` reads the body's `error` for its toast, so the sentence still reaches the user.

## FAMILIARISE_WEB-3K, FAMILIARISE_WEB-3J and FAMILIARISE_WEB-40: "No payment found for this order" on the cancel route

The cancel route runs the policy refund after the cancellation has committed and reports what happened to the money on the `refund` field of its 200 response; `useEventActions` already shows "We could not complete your refund automatically — our team has been alerted and will sort it out." for `status: "FAILED"`. Answering a 4xx at that point would tell the buyer a cancellation had failed when it had in fact succeeded, so the response contract was left alone. What changed is the capture: both refund catch blocks in `app/api/appointments/[appointmentId]/cancel/route.ts` now go through `reportRefundFailure`, which uses `isModelledRefundRefusal` from `lib/payments/operations/refund.ts` to report a `RefundError`, `RefundGatewayError` or `RefundValidationError` as expected at `warning`, and anything else at error. The `recordSystemError` row that puts the owed money on the ops surface is unchanged. FAMILIARISE_WEB-3J and FAMILIARISE_WEB-40 are the gateway adapter's own expected `info` report of the same outcome and were already correct; `NO_PAYMENT_FOUND` was also registered in `BUSINESS_ERROR_CODES` as a 409 `REFUND_BLOCKED` with a user sentence, so a future route that classifies it can never answer 500. None of the three is closed by this change, because the events still arrive at their new level.

## FAMILIARISE_WEB-3D: "has no refundable balance" on the moderation action route

The event is `reportModelledRefundOutcome`'s own expected `info` report from `refundPayment`, which is correct and unchanged. The moderation bulk cancel in `lib/moderation/cancel-user-engagements.ts` captured the same error a second time at error level in `issueFullRefund`; that capture now uses the same modelled-refusal test and reports it as expected at `warning`. The route answers 200 with the failure on the action's side-effect summary, which staff already see, and a 409 would have been wrong for the same reason as on the cancel route.

## FAMILIARISE_WEB-14 and FAMILIARISE_WEB-2T on the consultant settings page

FAMILIARISE_WEB-14, "Failed to sync Novu subscriber", carried `httpStatus: 504` on every event: it is the Netlify edge timeout, a genuine failure, and was left alone. FAMILIARISE_WEB-2T, "Failed to update settings", discarded the response body, so the route's 400 refusals ("Cannot switch schedule type while you have N active appointment(s)…", "Custom slot start time must be before end time") and any 5xx were indistinguishable and all captured at error level with a blank toast. `SettingsTab` now parses through `requireJsonResponse`, shows the server's sentence for an expected refusal, and only reports when the error is not one.

## Verification

`tsc --noEmit` was clean after a cold Prisma generate, `eslint --max-warnings 0` reported nothing new on the touched files (the 26 findings in two test files and one action predate this change and are on untouched lines), the pin `__tests__/errors/refusal-rails.test.ts` and 28 sibling suites covering the changed routes passed, and `scripts/ci/check-terminology.ts` reported ok.
