/**
 * #1134 — subscribe the Stream webhook to every event handled by the dispatcher.
 *
 *   npx tsx scripts/stream/ensure-webhook-subscription.ts
 *   npx tsx scripts/stream/ensure-webhook-subscription.ts --check
 *   npx tsx scripts/stream/ensure-webhook-subscription.ts --apply
 */
import "dotenv/config";

import type { EventHook } from "stream-chat";

import { getStreamChatClient, isStreamConfigured } from "../../lib/stream-client";
import { compareStringsByCodeUnit } from "../../lib/stream/config-fingerprint";
import { HANDLED_EVENT_TYPES } from "../../lib/stream/webhook-events";

const ADDITIONAL_EVENT_TYPES = ["call.session_started"] as const;

const DESIRED_EVENT_TYPES = Array.from(
  new Set<string>([...HANDLED_EVENT_TYPES, ...ADDITIONAL_EVENT_TYPES]),
).sort(compareStringsByCodeUnit);

type IdentifiedHook = EventHook & { id: string };

const CHAT_EVENT_PREFIXES = ["user.", "message.", "channel.", "member."];

function productFor(eventType: string): "chat" | "video" {
  return CHAT_EVENT_PREFIXES.some((p) => eventType.startsWith(p))
    ? "chat"
    : "video";
}

function hookAccepts(hook: EventHook, eventType: string): boolean {
  const product = (hook as { product?: string }).product;
  if (!product || product === "all") return true;
  return product === productFor(eventType);
}

export type EnsureMode = "dry-run" | "check" | "apply";
export const DRIFT_EXIT_CODE = 2;

function annotate(message: string): void {
  console.error(
    process.env.GITHUB_ACTIONS ? `::error::${message}` : `ERROR: ${message}`,
  );
}

export async function ensureWebhookSubscription(
  mode: EnsureMode,
): Promise<number> {
  const apply = mode === "apply";
  if (!isStreamConfigured()) {
    console.error(
      "Stream is not configured — set STREAM_API_KEY and STREAM_API_SECRET",
    );
    return 1;
  }

  const client = getStreamChatClient();
  const app = await client.getAppSettings();
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
  const widened = new Map<string, string[]>();
  const unplaceable = new Set(DESIRED_EVENT_TYPES);

  for (const hook of hooks) {
    const current = new Set(hook.event_types ?? []);
    const receivesAll = current.has("*");

    const eligible = DESIRED_EVENT_TYPES.filter((t) => hookAccepts(hook, t));
    for (const t of eligible) unplaceable.delete(t);

    const missing = eligible.filter((t) => !receivesAll && !current.has(t));
    const product = (hook as { product?: string }).product ?? "unscoped";

    console.log(`\nhook ${hook.id}  enabled=${hook.enabled}  product=${product}`);
    console.log(`  url: ${hook.webhook_url}`);
    console.log(`  subscribed: ${current.size}${receivesAll ? " (wildcard)" : ""}`);

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

    const next = Array.from(new Set([...current, ...missing])).sort(
      compareStringsByCodeUnit,
    );
    widened.set(hook.id, next);
    console.log(`  → will widen to ${next.length} event types`);
  }

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
      console.error(`\n  product '${product}' — no hook on this app is scoped to it:`);
      for (const t of [...types].sort(compareStringsByCodeUnit)) {
        console.error(`    · ${t}`);
        if (mode === "check") {
          annotate(
            `Stream webhook drift: no '${product}' hook can carry ${t}, so the ` +
              `dispatcher handles an event that is never delivered`,
          );
        }
      }
      console.error(
        `  Create a '${product}' webhook in the Stream dashboard pointing at <origin>/api/stream/webhooks.`,
      );
    }
  }

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

  if (unplaceable.size > 0) return DRIFT_EXIT_CODE;
  if (changed > 0 && mode === "check") return DRIFT_EXIT_CODE;
  return 0;
}

if (require.main === module) {
  const argv = process.argv;
  const mode: EnsureMode = argv.includes("--apply")
    ? "apply"
    : argv.includes("--check")
      ? "check"
      : "dry-run";
  ensureWebhookSubscription(mode)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error("ensure-webhook-subscription failed:", err);
      process.exitCode = 1;
    });
}
