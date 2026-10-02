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
 *   npx tsx scripts/stream/ensure-webhook-subscription.ts --check
 *   npx tsx scripts/stream/ensure-webhook-subscription.ts --apply
 *   npx tsx scripts/stream/ensure-webhook-subscription.ts --restore
 *
 * #1270 — the script used to return 0 no matter what it found, which is why it
 * could not be wired to anything. A drift detector that always exits green
 * detects nothing, and the drift it was written to find is precisely the kind
 * nobody goes looking for: subscription state lives in the Stream dashboard,
 * where a change leaves no trace in this repository. `--check` is the CI mode —
 * it never writes, annotates each finding for the Actions log, and exits
 * non-zero so the scheduled job goes red the day the live hook stops covering
 * what the dispatcher handles.
 *
 * ## Why there is a pre-image and a `--restore` at all
 *
 * Every other script in this folder writes a pre-image before it writes anything
 * and has a way back. This one did not, and it is the one script here that writes
 * to the shared APP rather than to one call type — so the thing it could destroy
 * is the single most expensive object in the account: `event_hooks`, one hook
 * carrying every video event type the whole pipeline depends on. The symptom of
 * losing it is indistinguishable from 2026-08-13, when the pipeline had never
 * processed an event, and there would have been no record of what it had been
 * subscribed to.
 *
 * `--restore` reinstates the pre-image's `event_types` per hook, by id, and
 * NOTHING else. It does not restore a whole `event_hooks` array: a rollback that
 * also reinstated hooks another integration has since added would delete live
 * configuration, and a rollback that reinstated one another integration has since
 * removed would recreate it. The unit is the field this script changed.
 */
import "dotenv/config";

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { EventHook } from "stream-chat";

import {
  getStreamChatClient,
  isStreamConfigured,
} from "../../lib/stream-client";
import { HANDLED_EVENT_TYPES } from "../../lib/stream/webhook-events";
import { canonical } from "../../lib/stream/config-fingerprint";
import { requireNamedTargetApp } from "./target-guard";

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

/**
 * Event types are partitioned by PRODUCT, and a hook may only carry events from
 * its own.
 *
 * This is not a detail. The live app has exactly one hook, scoped to `video`,
 * and `updateAppSettings` refuses the whole write — atomically, so nothing
 * lands — if the payload gives it a chat event:
 *
 *   invalid event types for hook 44a1d716-…: event types
 *   [message.flagged user.flagged] do not belong to product 'video'
 *
 * The first version of this script had no concept of `product`. It reported all
 * five unsubscribed events as simply "missing", which read as one write away
 * from fixed, when two of them could never live on that hook at all. Chat
 * moderation would have stayed dead with the script reporting success.
 */
const CHAT_EVENT_PREFIXES = ["user.", "message.", "channel.", "member."];

function productFor(eventType: string): "chat" | "video" {
  return CHAT_EVENT_PREFIXES.some((p) => eventType.startsWith(p))
    ? "chat"
    : "video";
}

/**
 * Whether a hook may carry an event type.
 *
 * A hook with no `product` is treated as unconstrained: the field is optional in
 * the SDK, and refusing to widen a hook we cannot classify would be worse than
 * letting Stream reject it with a precise message.
 */
function hookAccepts(hook: EventHook, eventType: string): boolean {
  const product = (hook as { product?: string }).product;
  if (!product || product === "all") return true;
  return product === productFor(eventType);
}

/**
 * `dry-run` reports and exits 0 — the mode a human runs first to see what the
 * script would do. `check` reports, annotates and exits {@link DRIFT_EXIT_CODE}
 * when the live app does not cover every handled event; it is what CI runs.
 * `apply` is the only mode that widens, and `restore` is the only mode that
 * narrows back to the pre-image.
 */
export type EnsureMode = "dry-run" | "check" | "apply" | "restore";

/**
 * Where the pre-image lives. Committed to a stable, repo-relative path rather
 * than a timestamped file in tmpdir, because `--restore` reads it back on a LATER
 * invocation — a path only the writing process could name made the rollback
 * unusable in practice. `ensure-chat-type-grants.ts` reaches the same conclusion
 * for the same reason and says so at the same place.
 */
const PRE_IMAGE_PATH = join(
  process.cwd(),
  ".stream-backups",
  "webhook-subscription.json",
);

/**
 * The rollback target, and deliberately the SMALLEST thing that undoes this
 * script: one `event_types` array per hook id.
 *
 * A whole `event_hooks` array would be the tidier snapshot and a worse rollback —
 * reinstating it would delete any hook another integration has added since, and
 * recreate any it has removed. Only the field this script changed, keyed by id,
 * so a hook that no longer exists is skipped rather than resurrected.
 */
interface PreImage {
  capturedAt: string;
  /** hook id -> the `event_types` it carried before this script widened it. */
  hooks: Record<string, string[]>;
}

function readPreImage(): PreImage | null {
  try {
    const parsed = JSON.parse(readFileSync(PRE_IMAGE_PATH, "utf8")) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as PreImage).hooks !== "object" ||
      (parsed as PreImage).hooks === null
    ) {
      return null;
    }
    return parsed as PreImage;
  } catch {
    return null;
  }
}

/**
 * Write-then-rename, so an interrupted write cannot leave a truncated pre-image
 * where a valid one used to be. Same directory, so the rename stays on one
 * filesystem and is atomic — the sibling does this for the same reason.
 */
function writePreImage(image: PreImage): void {
  mkdirSync(dirname(PRE_IMAGE_PATH), { recursive: true });
  const tmpPath = `${PRE_IMAGE_PATH}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(image, null, 2));
  renameSync(tmpPath, PRE_IMAGE_PATH);
}

/**
 * Distinct from 1 on purpose. 1 means the script could not evaluate drift at
 * all — Stream unconfigured, or no webhook hook to inspect — which is a
 * configuration failure of the RUNNER. 2 means it evaluated the app
 * successfully and there really is drift. Both fail the CI job, but the log
 * reader should not have to guess which of the two happened, because a missing
 * `STREAM_API_SECRET` on the runner and a narrowed hook in the dashboard need
 * completely different responses.
 */
export const DRIFT_EXIT_CODE = 2;

/** GitHub Actions annotation; a plain line anywhere else. */
function annotate(message: string): void {
  console.error(
    process.env.GITHUB_ACTIONS ? `::error::${message}` : `ERROR: ${message}`,
  );
}

export async function ensureWebhookSubscription(
  mode: EnsureMode,
  opts: { argv?: readonly string[] } = {},
): Promise<number> {
  const apply = mode === "apply";
  const restoring = mode === "restore";
  // `--apply --restore` is the writing rollback, so `apply` alone is not the
  // question — "is THIS invocation going to write" is. Derived from argv rather
  // than folded into the mode so that `--restore` and `--check` stay
  // distinguishable, which is what lets the restore branch report without
  // writing.
  const willWrite =
    apply || (restoring && (opts.argv ?? []).includes("--apply"));
  if (!isStreamConfigured()) {
    console.error(
      "Stream is not configured — set STREAM_API_KEY and STREAM_API_SECRET",
    );
    return 1;
  }

  const client = getStreamChatClient();
  const app = await client.getAppSettings();

  // This script writes the app's `event_hooks`, so it is gated like every other
  // writer in this folder: dev, preview and production share one Stream app and
  // the credentials alone do not say which one. `--restore` is a write too, and
  // it is reached precisely when something is already wrong.
  if (
    !requireNamedTargetApp({
      script: "scripts/stream/ensure-webhook-subscription.ts",
      writes: willWrite,
      argv: opts.argv,
      // Free — `getAppSettings` was called anyway.
      liveAppName: app.app?.name,
    })
  ) {
    return 1;
  }

  const preImage = readPreImage();

  if (restoring && !preImage) {
    console.error(
      `\n🛑 Cannot restore — no pre-image at ${PRE_IMAGE_PATH}.\n` +
        `Restoring without one would mean guessing which events the hook was\n` +
        `subscribed to before, and guessing wrong in either direction is either a\n` +
        `dead pipeline or a silent re-subscription nobody reviewed.\n` +
        `Re-subscribe the hook in the Stream dashboard instead.\n`,
    );
    return 1;
  }

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

  // --- Rollback ------------------------------------------------------------
  // Taken before the widening loop, because restoring and widening are opposite
  // intents and running both in one invocation would make the exit code mean
  // nothing. Like `ensure-chat-type-grants.ts`, `--restore` REPORTS and
  // `--apply --restore` writes: a rollback is the one command somebody types
  // while an incident is open, and it should show them what it is about to undo
  // before it undoes it.
  if (restoring) {
    // Re-checked rather than carried through the guard above: `restoring` alone
    // does not narrow `preImage`, and re-reading the file would mean two chances
    // for it to change underneath an operator mid-incident — so this asserts the
    // value the guard already validated rather than calling the reader again.
    if (!preImage) {
      console.error(
        `\n🛑 Cannot restore — no pre-image at ${PRE_IMAGE_PATH}.\n`,
      );
      return 1;
    }
    const rollback = preImage;
    const known = new Set(hooks.map((h) => h.id));
    const restorable = Object.entries(rollback.hooks).filter(([id]) =>
      known.has(id),
    );
    const gone = Object.keys(rollback.hooks).filter((id) => !known.has(id));

    if (restorable.length === 0) {
      console.error(
        `\n🛑 Cannot restore — none of the hook ids in ${PRE_IMAGE_PATH} exist on\n` +
          `   this app any more. Restoring would be guesswork.\n`,
      );
      return 1;
    }
    if (gone.length > 0) {
      // Reported, not fatal: a hook deleted since the pre-image was taken must
      // NOT be recreated by a rollback, and the operator should know that is why
      // their list does not match.
      console.log(
        `\nhook(s) in the pre-image no longer exist and will NOT be recreated: ${gone.join(", ")}`,
      );
    }

    const differs = restorable.filter(([id, types]) => {
      const current = hooks.find((h) => h.id === id)?.event_types ?? [];
      return (
        canonical([...current].sort(byCodeUnit)) !==
        canonical([...types].sort(byCodeUnit))
      );
    });

    for (const [id, types] of restorable) {
      const current = hooks.find((h) => h.id === id)?.event_types ?? [];
      const mark = differs.some(([d]) => d === id) ? "→" : "=";
      console.log(
        `\nhook ${id}  ${current.length} ${mark} ${types.length} event types`,
      );
      if (mark === "=") console.log(`  already at the pre-image value`);
    }

    if (differs.length === 0) {
      console.log("\n✅ already at the pre-image value — nothing to restore");
      return 0;
    }

    if (!willWrite) {
      console.log(
        `\n(dry run — re-run with --apply to restore: ` +
          `npx tsx scripts/stream/ensure-webhook-subscription.ts --apply --restore)`,
      );
      return 0;
    }

    // ONE write carrying every hook the app has, for the same reason the
    // widening path takes one: the array is replaced wholesale, so a payload
    // built from anything less than the complete list deletes what it omits.
    const byId = new Map(differs);
    const nextHooks = allHooks.map((h) => {
      const next = h.id ? byId.get(h.id) : undefined;
      return next ? { ...h, event_types: next } : h;
    });
    await client.updateAppSettings({ event_hooks: nextHooks });

    // The rollback needs verifying, and used to be unverifiable because there was
    // nothing to verify against. Assert the read-back equals the pre-image
    // EXACTLY: a restore that only mostly works leaves the pipeline in a state
    // nobody has ever reviewed, and "it went back to nearly what it was" is not a
    // state anybody can reason about at 2am.
    const verified = await client.getAppSettings();
    // `Object.entries`, not `map.entries()`. A Map's entries are not own
    // enumerable properties, so `Object.entries(new Map([...]))` is `[]` — the
    // verification below would compare nothing, find nothing, and report success
    // on a rollback that never happened. The same mistake is invisible in
    // TypeScript at the point of the bug because both sides are iterable.
    const mismatched = [...byId.entries()].filter(([id, types]) => {
      const now = (verified.app?.event_hooks ?? []).find(
        (h): h is IdentifiedHook => h.id === id,
      );
      return (
        canonical([...(now?.event_types ?? [])].sort(byCodeUnit)) !==
        canonical([...types].sort(byCodeUnit))
      );
    });

    if (mismatched.length > 0) {
      console.error(
        `\n🚨 Stream did not restore: ${mismatched.map(([id]) => id).join(", ")}.` +
          `\n   Do not report this run as successful. The subscription is in a` +
          `\n   state nobody chose; re-read it in the dashboard before serving traffic.`,
      );
      return 1;
    }

    console.log(
      `\n✅ restored ${differs.length} hook(s) to their pre-image event_types; ` +
        `${allHooks.length} hook(s) preserved`,
    );
    return 0;
  }

  // Snapshot BEFORE the write, and never silently overwrite an existing one.
  // Applying twice would otherwise capture the already-widened state as the
  // rollback target, redefining "before" as "after" so `--restore` becomes a
  // no-op that reports success — and the failure is invisible until the day
  // somebody actually needs the rollback. Idempotency means the second run does
  // not need a new snapshot anyway: by then the live state either already
  // matches the desired one, or the first pre-image is still the right target.
  if (apply) {
    if (existsSync(PRE_IMAGE_PATH)) {
      console.log(
        `Pre-image already exists at ${PRE_IMAGE_PATH} — keeping it.\n` +
          `(delete it deliberately to re-baseline onto the current live state)\n`,
      );
    } else {
      const captured: PreImage = {
        capturedAt: new Date().toISOString(),
        hooks: Object.fromEntries(
          hooks.map((h) => [h.id, [...(h.event_types ?? [])].sort(byCodeUnit)]),
        ),
      };
      writePreImage(captured);
      console.log(`Pre-image written to ${PRE_IMAGE_PATH}\n`);
    }
  }

  let changed = 0;
  /** hook id -> its widened event_types. Applied in ONE write after the loop. */
  const widened = new Map<string, string[]>();
  /** Events no hook on this app is allowed to carry. */
  const unplaceable = new Set(DESIRED_EVENT_TYPES);

  for (const hook of hooks) {
    const current = new Set(hook.event_types ?? []);
    // A hook subscribed to "*" already receives everything.
    const receivesAll = current.has("*");

    // Only events this hook's product permits. Offering it anything else makes
    // Stream refuse the ENTIRE update, so one impossible event silently costs
    // every possible one in the same write.
    const eligible = DESIRED_EVENT_TYPES.filter((t) => hookAccepts(hook, t));
    for (const t of eligible) unplaceable.delete(t);

    const missing = eligible.filter((t) => !receivesAll && !current.has(t));
    const product = (hook as { product?: string }).product ?? "unscoped";

    console.log(
      `\nhook ${hook.id}  enabled=${hook.enabled}  product=${product}`,
    );
    console.log(`  url: ${hook.webhook_url}`);
    console.log(
      `  subscribed: ${current.size}${receivesAll ? " (wildcard)" : ""}`,
    );

    if (missing.length === 0) {
      console.log(`  ✅ already covers every handled ${product} event`);
      continue;
    }

    console.log(`  MISSING (${missing.length}):`);
    for (const t of missing) console.log(`    + ${t}`);
    if (mode === "check") {
      annotate(
        `Stream webhook drift: hook ${hook.id} (${product}) is missing ` +
          `${missing.length} handled event type(s): ${missing.join(", ")}. ` +
          `Run scripts/stream/ensure-webhook-subscription.ts --apply.`,
      );
    }
    changed++;

    if (!apply) continue;

    // Union, never replace — of the event TYPES. The hooks ARRAY is handled
    // once after the loop; writing here submitted an array of one and deleted
    // every other hook on the app.
    const next = Array.from(new Set([...current, ...missing])).sort(byCodeUnit);
    widened.set(hook.id, next);
    console.log(`  → will widen to ${next.length} event types`);
  }

  // Events with nowhere to go. This is a configuration gap the script cannot
  // close: creating a hook decides a public URL and starts real deliveries, so
  // it belongs to a human, in the dashboard, the same way the "no webhook at
  // all" case above does.
  if (unplaceable.size > 0) {
    const byProduct = new Map<string, string[]>();
    for (const t of unplaceable) {
      const p = productFor(t);
      byProduct.set(p, [...(byProduct.get(p) ?? []), t]);
    }
    console.error(
      `\n⚠️  ${unplaceable.size} handled event(s) have NO hook that may carry them.`,
    );
    for (const [product, types] of byProduct) {
      console.error(
        `\n  product '${product}' — no hook on this app is scoped to it:`,
      );
      for (const t of [...types].sort(byCodeUnit)) {
        console.error(`    · ${t}`);
        if (mode === "check") {
          annotate(
            `Stream webhook drift: no '${product}' hook can carry ${t}, so the ` +
              `dispatcher handles an event that is never delivered`,
          );
        }
      }
      console.error(
        `  Create a '${product}' webhook in the Stream dashboard pointing at\n` +
          `  <origin>/api/stream/webhooks, then re-run. Until then these events are\n` +
          `  never delivered and the features behind them stay dead.`,
      );
    }
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

  // An unplaceable event is drift in EVERY mode, `--apply` included: writing
  // cannot fix it, because the remedy is a new hook in the dashboard and that
  // decides a public URL. A run that widened one hook and left two chat events
  // undeliverable has not finished the job, and must not say it has.
  if (unplaceable.size > 0) return DRIFT_EXIT_CODE;
  // Missing-but-placeable events are drift only while nothing has written them.
  if (changed > 0 && mode === "check") return DRIFT_EXIT_CODE;
  return 0;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  // `--restore` is checked BEFORE `--check` and independently of `--apply`,
  // because the two are combinable on purpose: `--restore` alone reports what it
  // would undo, `--apply --restore` undoes it. Mirrors
  // ensure-chat-type-grants.ts, where the rollback is `--apply --restore-*`.
  const mode: EnsureMode = argv.includes("--restore")
    ? "restore"
    : argv.includes("--apply")
      ? "apply"
      : argv.includes("--check")
        ? "check"
        : "dry-run";
  ensureWebhookSubscription(mode, { argv })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error("ensure-webhook-subscription failed:", err);
      process.exitCode = 1;
    });
}
