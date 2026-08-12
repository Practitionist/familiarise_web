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

const DESIRED_EVENT_TYPES = Array.from(
  new Set<string>([...HANDLED_EVENT_TYPES, ...ADDITIONAL_EVENT_TYPES]),
).sort();

interface EventHook {
  id: string;
  hook_type?: string;
  enabled?: boolean;
  webhook_url?: string;
  event_types?: string[];
}

export async function ensureWebhookSubscription(apply: boolean): Promise<number> {
  if (!isStreamConfigured()) {
    console.error(
      "Stream is not configured — set STREAM_API_KEY and STREAM_API_SECRET",
    );
    return 1;
  }

  const client = getStreamChatClient();
  const app = (await client.getAppSettings()) as unknown as {
    app?: { event_hooks?: EventHook[] };
  };
  const hooks = (app.app?.event_hooks ?? []).filter(
    (h) => h.hook_type === "webhook",
  );

  if (hooks.length === 0) {
    console.error(
      "No webhook hook configured on this Stream app. Create one in the dashboard\n" +
        "pointing at <origin>/api/stream/webhooks, then re-run this script.",
    );
    return 1;
  }

  let changed = 0;

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

    // Union, never replace: another integration may legitimately rely on event
    // types this codebase does not handle.
    const next = Array.from(new Set([...current, ...missing])).sort();
    await client.updateAppSettings({
      event_hooks: [{ ...hook, event_types: next }],
    } as never);
    console.log(`  ✅ applied — now ${next.length} event types`);
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
