/**
 * One-time reset of Novu-native in-app mutes.
 *
 * Postgres owns notification preferences, the server gates every bell before
 * triggering, and the families are synced read-only. A subscriber who muted
 * in-app delivery in Novu's own Inbox preference page before that still has
 * the mute stored in Novu, where it can silently drop a bell the server sent.
 * This re-enables in-app for the global preference and for every owned family
 * wherever it is off. Settings choices in Postgres are untouched.
 *
 * Idempotent: a subscriber with nothing muted is skipped, so a second run
 * reports zero changes and a partial run is simply resumed. Not a job: it is
 * run by hand once per environment, then deleted.
 *
 * ORDER: dry run, then --apply, BEFORE `npm run novu:sync` in that
 * environment. The sync makes the families read-only, and Novu may refuse a
 * per-family preference write on a read-only workflow; such refusals are
 * reported separately below.
 *
 *   npx tsx scripts/novu/clear-native-mutes.ts                       dry run, Development
 *   npx tsx scripts/novu/clear-native-mutes.ts --apply               write, Development
 *   npx tsx scripts/novu/clear-native-mutes.ts --env production      dry run, Production
 *
 * NOTE: a dry run READS the environment. An apply WRITES subscriber preferences.
 */
import "dotenv/config";

import { Novu } from "@novu/api";
import type {
  GetSubscriberPreferencesDto,
  PatchSubscriberPreferencesDto,
} from "@novu/api/models/components";
import {
  resolveNovuSecretKey,
  type NovuEnvironment,
} from "../../lib/novu/secret-key";
import { FAMILIES } from "../../lib/novu/templates/families";

/** The slice of the Novu SDK this script uses. */
export interface NovuPreferenceApi {
  subscribers: {
    search(request: { limit: number; after?: string }): Promise<{
      result: {
        data: Array<{ subscriberId: string }>;
        next: string | null;
      };
    }>;
    preferences: {
      list(request: {
        subscriberId: string;
      }): Promise<{ result: GetSubscriberPreferencesDto }>;
      update(
        dto: PatchSubscriberPreferencesDto,
        subscriberId: string,
      ): Promise<unknown>;
    };
  };
}

/** One in-app mute; a null workflow is the subscriber's global preference. */
export interface Mute {
  subscriberId: string;
  workflowId: string | null;
}

export interface ClearResult {
  scanned: number;
  mutes: Mute[];
  cleared: number;
  failures: Array<Mute & { error: string }>;
  /** Family writes Novu refused because the workflow is already read-only. */
  readOnlyRefusals: Mute[];
}

const READ_ONLY_REFUSAL = /read[\s_-]?only|critical/i;

const PAGE_SIZE = 100;
const OWNED_FAMILIES = new Set<string>(FAMILIES.map((f) => f.id));

export function mutesOf(
  subscriberId: string,
  preferences: GetSubscriberPreferencesDto,
): Mute[] {
  const mutes: Mute[] = [];
  if (preferences.global.channels.inApp === false) {
    mutes.push({ subscriberId, workflowId: null });
  }
  for (const pref of preferences.workflows) {
    const id = pref.workflow.identifier;
    if (OWNED_FAMILIES.has(id) && pref.channels.inApp === false) {
      mutes.push({ subscriberId, workflowId: id });
    }
  }
  return mutes;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Lists every subscriber's mutes and, only with `apply`, re-enables them. */
export async function clearNativeMutes(
  novu: NovuPreferenceApi,
  opts: { apply: boolean },
): Promise<ClearResult> {
  const result: ClearResult = {
    scanned: 0,
    mutes: [],
    cleared: 0,
    failures: [],
    readOnlyRefusals: [],
  };
  let after: string | undefined;
  do {
    const page = await novu.subscribers.search({
      limit: PAGE_SIZE,
      ...(after ? { after } : {}),
    });
    for (const { subscriberId } of page.result.data) {
      result.scanned += 1;
      let mutes: Mute[];
      try {
        const { result: prefs } = await novu.subscribers.preferences.list({
          subscriberId,
        });
        mutes = mutesOf(subscriberId, prefs);
      } catch (error) {
        result.failures.push({
          subscriberId,
          workflowId: null,
          error: errorText(error),
        });
        continue;
      }
      result.mutes.push(...mutes);
      if (!opts.apply) continue;
      for (const mute of mutes) {
        try {
          await novu.subscribers.preferences.update(
            {
              channels: { inApp: true },
              ...(mute.workflowId ? { workflowId: mute.workflowId } : {}),
            },
            subscriberId,
          );
          result.cleared += 1;
        } catch (error) {
          const text = errorText(error);
          if (mute.workflowId && READ_ONLY_REFUSAL.test(text)) {
            result.readOnlyRefusals.push(mute);
          } else {
            result.failures.push({ ...mute, error: text });
          }
        }
      }
    }
    after = page.result.next ?? undefined;
  } while (after);
  return result;
}

function targetEnvironment(args: string[]): NovuEnvironment {
  const i = args.indexOf("--env");
  return i !== -1 && args[i + 1] === "production"
    ? "production"
    : "development";
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const { name, key } = resolveNovuSecretKey(targetEnvironment(args));
  if (!key) throw new Error(`${name} is not set`);
  console.log(
    `Clearing native in-app mutes with ${name} (${apply ? "LIVE" : "DRY RUN"})...`,
  );

  const result = await clearNativeMutes(new Novu({ secretKey: key }), {
    apply,
  });

  console.log(
    `\nScanned ${result.scanned} subscriber(s); found ${result.mutes.length} in-app mute(s).`,
  );
  for (const mute of result.mutes.slice(0, 50)) {
    console.log(`  ${mute.subscriberId} ${mute.workflowId ?? "(global)"}`);
  }
  if (result.mutes.length > 50) console.log("  …");
  if (apply) console.log(`Cleared ${result.cleared}.`);
  if (result.readOnlyRefusals.length > 0) {
    console.error(
      `\n${result.readOnlyRefusals.length} family mute(s) refused because the workflow is read-only: \`novu:sync\` already ran in this environment. Run this script before the sync, or confirm in the Novu dashboard that read-only families ignore these mutes.`,
    );
    for (const mute of result.readOnlyRefusals.slice(0, 20)) {
      console.error(`  ${mute.subscriberId} ${mute.workflowId}`);
    }
  } else if (result.mutes.length > 0) {
    console.log("\n(dry run — re-run with --apply to clear them)");
  }
  if (result.failures.length > 0 || result.readOnlyRefusals.length > 0) {
    if (result.failures.length > 0) {
      console.error(
        `\n${result.failures.length} failure(s); re-run to resume:`,
      );
    }
    for (const f of result.failures.slice(0, 20)) {
      console.error(
        `  ${f.subscriberId} ${f.workflowId ?? "(global)"}: ${f.error}`,
      );
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
