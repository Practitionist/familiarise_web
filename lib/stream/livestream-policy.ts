/**
 * Livestream / HLS entitlement — ONE resolution of "may this meeting broadcast
 * on HLS", split so the two halves can be asked separately.
 *
 * ## Why HLS is a separate question from the call type
 *
 * A meeting being on the `livestream` call type says it is a broadcast shape
 * (backstage, one presenter publishing to many). It does NOT say the product
 * sells that broadcast on HLS. HLS participant-minutes cost more than full mesh
 * at class scale — a 200-seat class that fans out pays per viewer per minute,
 * which is a different order of magnitude from the same room meshed — so HLS is
 * a per-plan opt-in on top of the call type, the same shape as
 * `recordingEnabled` and `RecordingStoragePolicy` already are on all four plan
 * models.
 *
 * Keeping the two halves separate is not decoration. Callers need them apart:
 *
 *   - a client rendering the room asks "is this a broadcast at all?" to decide
 *     whether to show a presenter-stage UI, and asks the conjunction only to
 *     decide whether to show a "watch on HLS" affordance;
 *   - the one place that actually calls `start_hls` should ask only the
 *     conjunction, so a plan that never paid for HLS cannot be broadcast on by
 *     a code path that only checked the call type.
 *
 * ## There is no plan/tier enum, so the flag is injected
 *
 * `prisma/schema.prisma` has no commercial plan-tier enum. `PlanLevel`
 * (BEGINNER/INTERMEDIATE/ADVANCED/ALL_LEVELS) is a DIFFICULTY filter for the
 * explore facet — a free beginner webinar and a paid advanced course are both
 * legal in it, so it cannot stand in for what the buyer paid and gating a
 * metered egress feature on it would be a category error rather than a
 * conservative default. Inventing a tier enum here would be worse still: it
 * would fork the pricing vocabulary away from the four plan models and the
 * checkout path in a file whose only job is a boolean.
 *
 * So this module takes the flag as an injected boolean, exactly mirroring
 * `recordingEnabled`, and defaults it OFF. Fail-closed is the right direction
 * for the one predicate here that can spend money: a plan row that has not been
 * taught about HLS, or an arm of the query that did not select the field,
 * yields no HLS. A caller that wants a permissive answer must say so.
 *
 * ## Pure on purpose
 *
 * No Prisma, no Stream SDK, no I/O — the same "Prisma-free because client
 * components import it" posture as `lib/booking/entitlement.ts`. HLS is decided
 * in the room UI, so this has to load in a client bundle, and `Meeting` and the
 * four plan models are read through structural types rather than generated
 * ones: a `Prisma.Meeting` satisfies {@link LivestreamMeeting} because
 * `callType` is a `String`, which is precisely why the column is a `String`
 * rather than an enum.
 */

import { LIVESTREAM_CALL_TYPE, normalizeCallType } from "@/lib/stream/call-cid";

/**
 * The Meeting fields this policy reads. Deliberately the narrowest shape that
 * answers the question: a `select` narrower than the row is a valid argument,
 * and a wider one is not needed.
 */
export interface LivestreamMeeting {
  callType: string | null | undefined;
}

/**
 * The plan fields this policy reads.
 *
 * `livestreamEnabled` is the injected per-plan opt-in described above. It is
 * optional AND nullable on purpose — a four-plan union means a caller can hand
 * over whichever arm resolved, and a query that predates the flag or omits it
 * produces `undefined` rather than a compile error at the call site.
 */
export interface LivestreamPlan {
  livestreamEnabled?: boolean | null;
}

/**
 * Is this meeting on the broadcast call type?
 *
 * Reads the PERSISTED type, never the appointment type — a call's type is
 * immutable in Stream, so the row is the only thing that can say which one this
 * call really is. A null/undefined/garbage value normalises to `default`, which
 * is the safe direction: a 1:1 that mistook itself for a broadcast is a leaked
 * stage UI, whereas the reverse would let a consultation mint onto a type whose
 * grants are shaped for one-way broadcast.
 */
export function isLivestreamMeeting(
  meeting: LivestreamMeeting | null | undefined,
): boolean {
  return normalizeCallType(meeting?.callType) === LIVESTREAM_CALL_TYPE;
}

/**
 * Does this plan sell HLS?
 *
 * Truthiness of an explicit boolean, with absent meaning absent. A caller that
 * has genuinely decided the plan qualifies passes `true`; there is no tier
 * arithmetic here to be wrong about.
 */
export function livestreamEnabledForPlan(
  plan: LivestreamPlan | null | undefined,
): boolean {
  return plan?.livestreamEnabled === true;
}

/**
 * The one answer to "may we put this meeting on HLS": the call type qualifies
 * AND the plan bought it.
 *
 * Both halves, always. This is the predicate the `start_hls` call site wants,
 * and it is deliberately not expressible as one of the halves: a webinar plan
 * without the flag is a broadcast room that must not fan out, and a plan with
 * the flag whose meeting is a 1:1 must not be spent on HLS at all — a
 * consultation's participants are its counterpart and the buyer, and there is
 * no plan of theirs behind that meeting to have bought the feature.
 */
export function hlsAvailableFor(
  meeting: LivestreamMeeting | null | undefined,
  plan: LivestreamPlan | null | undefined,
): boolean {
  return isLivestreamMeeting(meeting) && livestreamEnabledForPlan(plan);
}
