/**
 * Orphaned Meeting Session Reconciliation Job
 *
 * Finds Meeting records where endedAt IS NULL and the linked
 * slot's endsAt is >1 hour ago. For each, queries Stream API to check
 * actual call status and reconciles accordingly.
 *
 * ## A row is closed only on a confirmed end (C2)
 *
 * Two answers mean "we do not know", and neither may be recorded as "it
 * finished": Stream saying the room is still open, and Stream being unable to
 * answer at all. Both leave `endedAt` null, which is a state the next run
 * re-checks and every other reader already handles. A row is closed on Stream's
 * `ended_at`, or on a definitive 404 for the call — the two answers in which
 * the room is known to be finished or known not to exist.
 *
 * This matters more than the usual "don't guess" argument, because
 * `Meeting.endedAt` is the END CAS: `supersedesRecordedEnd` refuses to move it
 * backwards, so a false stamp here cannot be corrected by the real end that
 * arrives afterwards.
 *
 * ## The room is asked about on ITS OWN call type, not on `default`
 *
 * Two call types exist now (`lib/stream/call-cid.ts`) and the type is immutable,
 * so a webinar's call is `livestream:<id>` and does not exist at
 * `default:<id>`. Since a 404 is the only answer permitted to close a row above,
 * a hardcoded type here would not merely lose information — it would manufacture
 * false ends for every broadcast, on a column nothing can walk back. So the type
 * is read off the row, and a 404 obtained against a coerced type is demoted to
 * "we do not know" for the same reason an outage is.
 *
 * Runs every 30 minutes via cleanup API route.
 */

// Why: tsx does not auto-load .env when this script runs outside the
// Next.js runtime. Without dotenv/config, DATABASE_URL + STREAM_API_KEY
// are undefined, PrismaClient throws on first query, and the Stream
// client fails to initialize. See
// docs/enterprise/50-operations/03-runbooks.md "Running cron jobs locally".
import "dotenv/config";
import prisma from "../../lib/prisma";
import {
  getStreamVideoClient,
  isStreamConfigured,
  streamHttpStatus,
  withStreamCircuitBreaker,
} from "../../lib/stream-client";
import {
  isKnownCallType,
  normalizeCallType,
  toCallId,
} from "../../lib/stream/call-cid";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { withCronLock } from "../../lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

export interface ReconciliationResult {
  processed: number;
  reconciled: number;
  streamNotFound: number;
  /**
   * #C2 — rows this run refused to close because Stream would not tell us
   * whether the call had ended (a still-open room, or an outage/timeout).
   *
   * Reported separately from `streamNotFound` because the two are opposites: a
   * 404 means the room does not exist and the row must be closed out, while
   * "could not ask" means the room's state is UNKNOWN and the row must stay
   * open. Folding them together is what let an outage stamp live calls as
   * finished.
   */
  unconfirmed: number;
  errors: number;
  success: boolean;
  details: string[];
}

/**
 * Rows read per database page.
 *
 * The old `take: 100` bounded the number of Stream calls a run made, and it
 * still does — but not by being the only page. #C2 makes a row a legitimate
 * "nothing to write" outcome (Stream says the room is still open), and those
 * rows match the selector forever, so a single unbounded `take` would let them
 * starve every other row forever: the same 100 oldest keep coming back, and
 * nothing behind them is ever examined. Paging with a cursor is what turns "this
 * run examined 100 rows" back into "this run examined the 100 oldest, then the
 * next 100 oldest".
 */
const PAGE_SIZE = 100;

/**
 * How many rows one run will ASK STREAM about.
 *
 * The ceiling the `take` used to be: the point of the original bound was never
 * to cap database reads, it was to cap sequential 30-second provider timeouts
 * during an incident (#473). Skipped rows cost a lookup like any other, so the
 * lookup count is what has to be capped, and a run that stops at the cap leaves
 * the rest for the next half hour instead of dropping them.
 */
const MAX_STREAM_LOOKUPS = 200;

/**
 * Did the provider tell us this call does not exist?
 *
 * #C2 — the only error that justifies closing a row. Structured 404 only, no
 * message sniffing: this is an HTTP provider, not Postgres, and the status is
 * present on the error (`scripts/payments/reconcile-payment-status.ts` reads it
 * the same way). A timeout, a socket reset, a DNS failure and an open circuit
 * are all "we do not know", and `drain-sessions.ts:231` is the precedent for
 * what to do with that: leave `endedAt` null so the next run re-checks. Before
 * this, every one of them took the `stream_not_found` branch and wrote a past
 * timestamp onto a call that was still billing.
 */
function isCallMissing(error: unknown): boolean {
  // #1829 — this read `.statusCode`, which is a Razorpay/Stripe-shaped field. A
  // `call.get()` on a deleted call throws `StreamError` from @stream-io/node-sdk,
  // whose own keys are `["metadata", "code"]`: the status is at
  // `metadata.responseCode` and there is no `statusCode` at all. So the check was
  // always false, the 404 branch was dead code, and a call Stream has genuinely
  // deleted kept `endedAt: null` forever — re-selected and re-asked on every
  // 30-minute run, with the `streamNotFound` counter permanently 0, which is the
  // exact distinction this counter was added to report.
  return streamHttpStatus(error) === 404;
}

/**
 * Was the lookup aimed at the call type the row actually claims?
 *
 * The lookup asks `normalizeCallType(Meeting.callType)`, and `normalizeCallType`
 * coerces a value it cannot read down to `default`. That is the right coercion
 * everywhere else — it guarantees the CID names a call type this app owns — but
 * here it silently changes what a 404 MEANS: a 404 against `default:<id>` says
 * the room is gone only if `default` is the room. On an unreadable
 * `Meeting.callType` the honest reading of a 404 is "we asked about the wrong
 * room", and the answer to that is not to close the row.
 *
 * Narrow on purpose. The column is `String @default("default")` and cannot be
 * NULL today, so this only fires on a value somebody hand-wrote, on a future
 * writer that widened Stream's vocabulary without widening `ALL_CALL_TYPES` — or
 * on a query that stopped selecting the column, which is the cheapest mistake of
 * the three and the one a `select` edit makes without anybody noticing. Which is
 * exactly the moment a guard earns its keep: by then there are real rows, and the
 * failure is unrecoverable.
 */
function askedTheRowsCallType(callType: string | null | undefined): boolean {
  return isKnownCallType(
    typeof callType === "string" ? callType.trim().toLowerCase() : "",
  );
}

// #476 — entry-level cron lock; fail-open (repeat-safe side effects).
export async function reconcileOrphanedSessions(): Promise<ReconciliationResult> {
  return withCronLock("reconcile-orphaned-sessions", { failMode: "open" }, () =>
    reconcileOrphanedSessionsUnlocked(),
  );
}

async function reconcileOrphanedSessionsUnlocked(): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    processed: 0,
    reconciled: 0,
    streamNotFound: 0,
    unconfirmed: 0,
    errors: 0,
    success: true,
    details: [],
  };

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  if (!isStreamConfigured()) {
    // Nothing can be asked, so nothing can be confirmed. Falling through to the
    // slot-end fallback here would stamp every row in the table with a past
    // timestamp, which is how a room that nobody can verify becomes a room that
    // the product says finished. This has to be a loud no-op, not a silent one:
    // the previous shape counted these under `streamNotFound` and moved on.
    result.errors++;
    result.success = false;
    result.details.push(
      "Stream is not configured — no session end can be confirmed; left every row open",
    );
    return result;
  }

  let cursor: string | null = null;
  let lookups = 0;

  // The only two columns this job reads off a session. Annotated rather than
  // inferred because the cursor is threaded back into the next page's query,
  // which makes the inferred type self-referential through the client's own
  // generics.
  let page: Array<{
    id: string;
    streamCallId: string;
    callType: string;
    occurrence: { endsAt: Date };
  }> = [];

  // Paged, and ordered by how long a row has been overdue rather than by
  // insertion: the first `take: 100` this job had came with NO orderBy at all,
  // so which hundred rows a run examined was whatever the planner produced, and
  // nothing in the query said the most-overdue rows were the ones that mattered.
  // `id` is the tiebreak, because cursor paging over a non-unique order is not
  // stable and a page can repeat or skip rows.
  for (;;) {
    if (lookups >= MAX_STREAM_LOOKUPS) {
      result.details.push(
        `Stream lookup budget reached (${MAX_STREAM_LOOKUPS}) — the rest are left for the next run`,
      );
      break;
    }

    // Find orphaned sessions: endedAt is null and slot ended >1 hour ago
    page = await prisma.meeting.findMany({
      where: {
        endedAt: null,
        occurrence: {
          endsAt: { lt: oneHourAgo },
        },
      },
      include: {
        occurrence: true,
      },
      orderBy: [{ occurrence: { endsAt: "asc" } }, { id: "asc" }],
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    if (page.length === 0) break;
    cursor = page[page.length - 1].id;

    console.log(
      `[reconcile-orphaned-sessions] Page of ${page.length} orphaned sessions (lookup ${lookups}/${MAX_STREAM_LOOKUPS})`,
    );

    for (const session of page) {
      result.processed++;
      lookups++;

      try {
        let endedAt: Date;
        let endedReason: string;

        try {
          // #1134 P1-5 — this was the one site that did NOT normalise the cid.
          // `streamCallId` stores the bare id, but three other sites defensively
          // split on ":" while this passed the raw value straight through, so a
          // prefixed value always 404'd here and the session was silently
          // recorded UNVERIFIED. One helper now owns the split.
          //
          // And the TYPE half is read off the row rather than assumed: a
          // webinar's call exists on `livestream:<id>`, so a hardcoded `default`
          // 404s a live broadcast — and this file's whole doctrine (#C2) is that
          // a 404 is the ONLY answer allowed to close a row. Assuming the type
          // would therefore manufacture false ends, unrecoverably.
          const client = getStreamVideoClient();
          const call = client.video.call(
            normalizeCallType(session.callType),
            toCallId(session.streamCallId),
          );
          // #473 — a Stream outage otherwise means 100 sequential 30s timeouts
          // per run. Fast-fail into the slot-end fallback instead.
          const response = await withStreamCircuitBreaker(() => call.get());

          if (response.call.ended_at) {
            // Stream confirms the call ended.
            endedAt = new Date(response.call.ended_at);
            endedReason = "reconciled";
            result.reconciled++;
          } else {
            // #C2 — Stream answered, and the answer is "this room is still
            // open". The old branch read the SLOT's end time here and wrote it
            // as the meeting's end, which is a statement about the calendar
            // masquerading as a statement about the call: a consultation that
            // overran its slot, or a room the consultant closed and Stream has
            // not yet published `ended_at` for, was recorded as finished while
            // participants were still in it. It is also unrecoverable in the
            // direction that hurts — `endedAt` is the END CAS every other writer
            // compares against, so a false stamp cannot be corrected by a later
            // genuine end (see `supersedesRecordedEnd`), the drain stops
            // considering the room held, and the call keeps billing against a row
            // that says it finished an hour ago.
            //
            // So this writes NOTHING. `endedAt: null` is the truthful state and
            // the next run re-checks: a genuinely abandoned room eventually
            // reports an `ended_at` (the SFU's own duration cap, the inactivity
            // timeout, or an explicit end) and is reconciled then. This is the
            // same refusal `drain-sessions.ts` makes, and for the same reason.
            result.unconfirmed++;
            result.details.push(
              `Session ${session.id} (call: ${session.streamCallId}): Stream reports the call still open — left open`,
            );
            continue;
          }
        } catch (streamError) {
          if (!isCallMissing(streamError)) {
            // #C2 — we could not ask, so we do not know. Same reasoning as the
            // branch above, and the same cost if ignored: a breaker trip during
            // an incident used to close out every row in the batch as though the
            // provider had said the call was gone.
            result.unconfirmed++;
            result.details.push(
              `Session ${session.id} (call: ${session.streamCallId}): Stream unreachable — left open`,
            );
            console.warn(
              `[reconcile-orphaned-sessions] Stream lookup inconclusive for ${session.streamCallId}:`,
              streamError instanceof Error
                ? streamError.message
                : JSON.stringify(streamError),
            );
            continue;
          }
          // A definitive 404: the room does not exist, so it cannot be live and
          // billing. The row is closed out on the slot's end, which is the only
          // time we have.
          //
          // …but only if the 404 was aimed at this row's own call type. See
          // `askedTheRowsCallType`: on a value we could not read, the lookup ran
          // against a coerced `default` and the 404 is evidence about a different
          // room. That is not an answer, so it is not allowed to be one.
          if (!askedTheRowsCallType(session.callType)) {
            result.unconfirmed++;
            result.details.push(
              `Session ${session.id} (call: ${session.streamCallId}): Meeting.callType is "${session.callType}", which is not a call type this app owns — the lookup ran against a different room, so nothing was closed`,
            );
            continue;
          }
          endedAt = new Date(session.occurrence.endsAt);
          endedReason = "stream_not_found";
          result.streamNotFound++;

          console.warn(
            `[reconcile-orphaned-sessions] Stream has no call for ${session.streamCallId}:`,
            streamError instanceof Error
              ? streamError.message
              : JSON.stringify(streamError),
          );
        }

        // #1569 D2 — close the room only; the end + 1 h slot pass is the one
        // writer of the occurrence's outcome and reads presence, not this guess.
        // CAS on the open room: a webhook or the drain that closed it meanwhile wins.
        await prisma.meeting.updateMany({
          where: { id: session.id, endedAt: null },
          data: { endedAt, endedReason },
        });

        result.details.push(
          `Session ${session.id} (call: ${session.streamCallId}): ${endedReason}`,
        );
      } catch (error) {
        result.errors++;
        result.success = false;
        const msg = error instanceof Error ? error.message : String(error);
        result.details.push(`Session ${session.id} FAILED: ${msg}`);
        console.error(
          `[reconcile-orphaned-sessions] Failed to reconcile session ${session.id}:`,
          msg,
        );
      }
    }

    // A short page means the set is exhausted. Without this the loop would ask
    // for one more page every run, which is cheap, but the log would imply a
    // backlog that does not exist.
    if (page.length < PAGE_SIZE) break;
  }

  return result;
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

// Allow direct execution
if (require.main === module) {
  runJob("reconcile-orphaned-sessions", async () => {
    await abortIfMaintenance("reconcile-orphaned-sessions");
    Sentry.logger.info("job:reconcile-orphaned-sessions started");
    console.log("Starting orphaned session reconciliation...");

    try {
      const result = await reconcileOrphanedSessions();
      console.log("\nReconciliation Results:");
      console.log(`  Processed: ${result.processed}`);
      console.log(`  Reconciled: ${result.reconciled}`);
      console.log(`  Stream Not Found: ${result.streamNotFound}`);
      // #C2 — rows left open because the room's end could not be confirmed.
      // Non-zero is the job working: it means Stream said "still open" or could
      // not answer, and the row is waiting for a run that can.
      console.log(`  Left Open (unconfirmed): ${result.unconfirmed}`);
      console.log(`  Errors: ${result.errors}`);
      console.log(`  Success: ${result.success}`);

      Sentry.logger.info("job:reconcile-orphaned-sessions finished", {
        processed: result.processed,
        reconciled: result.reconciled,
        streamNotFound: result.streamNotFound,
        unconfirmed: result.unconfirmed,
        errors: result.errors,
        success: result.success,
      });
      if (!result.success) process.exitCode = 1;
    } finally {
      await disconnectDatabase();
    }
  });
}
