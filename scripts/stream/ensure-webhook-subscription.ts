/**
 * Reconcile the Stream webhook hook (enabled, URL, event list) with the control-plane contract.
 * `--check` exits 2 on drift without writing.
 *
 *   npx tsx scripts/stream/ensure-webhook-subscription.ts
 *   npx tsx scripts/stream/ensure-webhook-subscription.ts --check
 *   npx tsx scripts/stream/ensure-webhook-subscription.ts --apply
 */
import "dotenv/config";

import type { EventHook } from "stream-chat";

import {
  getStreamChatClient,
  isStreamConfigured,
} from "../../lib/stream-client";
import { compareStringsByCodeUnit } from "../../lib/stream/config-fingerprint";
import {
  SORTED_DESIRED_EVENT_TYPES,
  evaluateHookDrift,
  expectedWebhookUrl,
  hookAccepts,
  productFor,
  type HookDriftReport,
} from "../../lib/stream/control-plane-contract";

type IdentifiedHook = EventHook & { id: string };

export type EnsureMode = "dry-run" | "check" | "apply";
export const DRIFT_EXIT_CODE = 2;

function annotate(message: string): void {
  console.error(`ERROR: ${message}`);
}

function formatDriftReasons(drift: HookDriftReport): string {
  const reasons: string[] = [];
  if (drift.receivesAll) reasons.push("wildcard subscription active");
  if (drift.disabled) reasons.push("hook disabled");
  if (drift.urlMismatch) reasons.push("webhook_url differs from the contract");
  if (drift.missing.length > 0) {
    reasons.push(`missing [${drift.missing.join(", ")}]`);
  }
  if (drift.extra.length > 0) {
    reasons.push(`extra [${drift.extra.join(", ")}]`);
  }
  return reasons.join("; ");
}

function logHookDriftDetails(
  hook: IdentifiedHook,
  drift: HookDriftReport,
  mode: EnsureMode,
): void {
  if (drift.receivesAll) {
    console.log(`  WILDCARD detected (unfiltered delivery across all events)`);
  }
  if (drift.disabled) console.log(`  DISABLED (deliveries are not sent)`);
  if (drift.urlMismatch) {
    console.log(
      `  URL differs from the contract; --apply keeps it unless --rewrite-url is also passed`,
    );
  }
  if (drift.missing.length > 0) {
    console.log(`  MISSING (${drift.missing.length}):`);
    for (const t of drift.missing) console.log(`    + ${t}`);
  }
  if (drift.extra.length > 0) {
    console.log(`  EXTRA (${drift.extra.length}):`);
    for (const t of drift.extra) console.log(`    - ${t}`);
  }
  if (mode === "check") {
    annotate(
      `Stream webhook drift: hook ${hook.id} (${drift.product}) has ${formatDriftReasons(drift)}. ` +
        `Run scripts/stream/ensure-webhook-subscription.ts --apply.`,
    );
  }
}

function reportUnplaceableEvents(
  unplaceable: Set<string>,
  mode: EnsureMode,
): void {
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

function parseCliMode(argv: string[]): EnsureMode {
  if (argv.includes("--apply")) return "apply";
  if (argv.includes("--check")) return "check";
  return "dry-run";
}

export async function ensureWebhookSubscription(
  mode: EnsureMode,
  rewriteUrl = false,
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

  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  const expectedUrl = appUrl ? expectedWebhookUrl(appUrl) : undefined;
  let changed = 0;
  const reconciled = new Map<string, string[]>();
  const unplaceable = new Set(SORTED_DESIRED_EVENT_TYPES);

  for (const hook of hooks) {
    const eligible = SORTED_DESIRED_EVENT_TYPES.filter((t) =>
      hookAccepts(hook, t),
    );
    for (const t of eligible) unplaceable.delete(t);
    if (eligible.length === 0) continue;

    const drift = evaluateHookDrift(hook, eligible, expectedUrl);
    const currentSize = hook.event_types?.length ?? 0;

    console.log(
      `\nhook ${hook.id}  enabled=${hook.enabled}  product=${drift.product}`,
    );
    console.log(`  url: ${hook.webhook_url}`);
    console.log(
      `  subscribed: ${currentSize}${drift.receivesAll ? " (wildcard)" : ""}`,
    );

    if (!drift.hasDrift) {
      console.log(
        `  ✅ matches exact desired ${drift.product} event set (${eligible.length})`,
      );
      continue;
    }

    logHookDriftDetails(hook, drift, mode);
    changed++;

    if (apply) {
      reconciled.set(hook.id, [...eligible]);
      console.log(`  → will set exact ${eligible.length} event types`);
    }
  }

  const legacyUrlActive = Boolean(app.app?.webhook_url?.trim());
  const legacyWildcard =
    legacyUrlActive && (app.app?.webhook_events ?? []).includes("*");
  if (legacyWildcard) {
    console.log(`\nlegacy V1 webhook_url is active with wildcard "*"`);
    if (mode === "check") {
      annotate(
        `Stream webhook drift: legacy V1 webhook_url is active with wildcard "*". ` +
          `Run scripts/stream/ensure-webhook-subscription.ts --apply.`,
      );
    }
    changed++;
  }

  if (unplaceable.size > 0) {
    reportUnplaceableEvents(unplaceable, mode);
  }

  if (apply && (reconciled.size > 0 || legacyWildcard)) {
    const nextHooks = allHooks.map((h) => {
      const next = h.id ? reconciled.get(h.id) : undefined;
      if (!next) return h;
      return {
        ...h,
        event_types: next,
        enabled: true,
        // The app is shared by every environment, so a URL rewrite needs its own explicit flag.
        ...(rewriteUrl && expectedUrl ? { webhook_url: expectedUrl } : {}),
      };
    });
    await client.updateAppSettings({
      event_hooks: nextHooks,
      ...(legacyWildcard ? { webhook_url: "" } : {}),
    });
    console.log(
      `\n✅ applied — ${reconciled.size} hook(s) updated, ${allHooks.length} preserved`,
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
  const mode = parseCliMode(process.argv);
  ensureWebhookSubscription(mode, process.argv.includes("--rewrite-url"))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error("ensure-webhook-subscription failed:", err);
      process.exitCode = 1;
    });
}
