/**
 * #1134 — subscribe the Stream webhook to every event we actually handle.
 *
 * The live hook was subscribed to SIX event types while
 * `lib/stream/webhook-dispatch.ts` handles TEN. The four missing ones were never
 * delivered, so two whole features shipped as dead code:
 *
 *   call.session_participant_joined / _left  → MeetingAttendance was never
 *     written. `detect-consultant-no-shows` has been running daily against a
 *     permanently empty table, and #471/#472 were never actually unblocked.
 *   user.flagged / message.flagged           → every report written by the chat
 *     UI landed in a queue nothing fed.
 *
 * This is the second independent cause of the zero-attendance figure; the first
 * was the missing webhook secret. Fixing one without the other changes nothing
 * for attendance.
 *
 * Subscription state lived only in the Stream dashboard, which is exactly how it
 * drifted from the code silently. Keeping it in a script makes it reviewable and
 * re-runnable.
 *
 * Idempotent. Dry-run is the default — pass `--apply` to write.
 *
 *   npx tsx scripts/stream/ensure-webhook-subscription.ts
 *   npx tsx scripts/stream/ensure-webhook-subscription.ts --apply
 */
import "dotenv/config";

import type { EventHook } from "stream-chat";

import { getStreamChatClient, isStreamConfigured } from "../../lib/stream-client";
import { HANDLED_EVENT_TYPES } from "../../lib/stream/webhook-events";

/**
 * `call.session_started` is subscribed even though the dispatcher does not
 * handle it yet: an unhandled event is a cheap no-op (the route returns
 * `handled: false` before doing any work), whereas an unsubscribed one cannot be
 * recovered after the fact. It is needed to record when a call ACTUALLY started
 * — every duration today is computed from the scheduled slot time instead.
 */
const ADDITIONAL_EVENT_TYPES = ["call.session_started"] as const;

/**
 * Code-unit ordering, stated explicitly.
 *
 * A bare `.sort()` already does exactly this for strings, but SonarCloud's
 * S2871 flags the missing comparator — and the remedy its message suggests is
 * `localeCompare`, which would be a real bug here rather than a style change.
 * These are event-type strings like `call.session_started` and
 * `message.flagged`: ICU collation treats `.` and `_` as ignorable punctuation
 * at the primary level, code units do not, so the two orderings genuinely
 * disagree. This sorted list is compared against the live hook's `event_types`
 * to decide whether an update is needed, so a locale-dependent order would make
 * that decision environment-dependent — the same failure mode as the DM channel
 * ids in #1134 P0-3. Do not "fix" this to localeCompare.
 */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const DESIRED_EVENT_TYPES = Array.from(
  new Set<string>([...HANDLED_EVENT_TYPES, ...ADDITIONAL_EVENT_TYPES]),
).sort(byCodeUnit);

/**
 * A hook we can address by id.
 *
 * The SDK declares `EventHook.id` optional because the id is server-generated —
 * you may omit it when creating one. Everything read back from `getAppSettings`
 * has one, but the type cannot say so, and `widened` is keyed by it.
 */
type IdentifiedHook = EventHook & { id: string };

export async function ensureWebhookSubscription(apply: boolean): Promise<number> {
  if (!isStreamConfigured()) {
    console.error(
      "Stream is not configured — set STREAM_API_KEY and STREAM_API_SECRET",
    );
    return 1;
  }

  const client = getStreamChatClient();
  const app = await client.getAppSettings();
  // Keep the COMPLETE list. `updateAppSettings({ event_hooks })` replaces the
  // whole array, so anything missing from the payload is deleted — including the
  // non-webhook hooks filtered out below (SQS, Pusher) and any second webhook
  // another integration owns. Widening one hook must not cost the others.
  const allHooks = app.app?.event_hooks ?? [];
  const hooks = allHooks.filter(
    (h): h is IdentifiedHook =>
      h.hook_type === "webhook" && typeof h.id === "string",
  );

  if (hooks.length === 0) {
    console.error(
      "No webhook hook configured on this Stream app. Create one in the dashboard\n" +
        "pointing at <origin>/api/stream/webhooks, then re-run this script.",
    );
    return 1;
  }

  let changed = 0;
  /** hook id -> its widened event_types. Applied in ONE write after the loop. */
  const widened = new Map<string, string[]>();

  for (const hook of hooks) {
    const current = new Set(hook.event_types ?? []);
    // A hook subscribed to "*" already receives everything.
    const receivesAll = current.has("*");
    const missing = DESIRED_EVENT_TYPES.filter(
      (t) => !receivesAll && !current.has(t),
    );

    console.log(`\nhook ${hook.id}  enabled=${hook.enabled}`);
    console.log(`  url: ${hook.webhook_url}`);
    console.log(`  subscribed: ${current.size}${receivesAll ? " (wildcard)" : ""}`);

    if (missing.length === 0) {
      console.log("  ✅ already covers every handled event");
      continue;
    }

    console.log(`  MISSING (${missing.length}):`);
    for (const t of missing) console.log(`    + ${t}`);
    changed++;

    if (!apply) continue;

    // Union, never replace — of the event TYPES. The hooks ARRAY is handled
    // once after the loop; writing here submitted an array of one and deleted
    // every other hook on the app.
    const next = Array.from(new Set([...current, ...missing])).sort(byCodeUnit);
    widened.set(hook.id, next);
    console.log(`  → will widen to ${next.length} event types`);
  }

  // One write, carrying every hook the app has. Two things went wrong with the
  // per-hook write this replaces. It submitted `[oneHook]`, which replaces the
  // entire `event_hooks` array — so a second webhook, or an SQS or Pusher hook,
  // was silently deleted. And doing it inside the loop meant each iteration
  // wrote a payload built from data read before the previous iteration's write,
  // so with two hooks to widen only the last would have survived.
  //
  // Latent today: this app has exactly one hook. It is the operator script for a
  // shared production Stream app with no rehearsal environment, so latent is not
  // good enough.
  if (apply && widened.size > 0) {
    const nextHooks = allHooks.map((h) => {
      const next = h.id ? widened.get(h.id) : undefined;
      return next ? { ...h, event_types: next } : h;
    });
    await client.updateAppSettings({ event_hooks: nextHooks });
    console.log(
      `\n✅ applied — ${widened.size} hook(s) widened, ${allHooks.length} preserved`,
    );
  }

  if (changed > 0 && !apply) {
    console.log("\n(dry run — re-run with --apply to write this to Stream)");
  }
  return 0;
}

if (require.main === module) {
  ensureWebhookSubscription(process.argv.includes("--apply"))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error("ensure-webhook-subscription failed:", err);
      process.exitCode = 1;
    });
}
