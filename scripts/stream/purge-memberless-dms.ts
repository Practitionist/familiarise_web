/**
 * Delete phantom DM channels — `messaging` channels with fewer than two members.
 *
 * ## Where they came from
 *
 * `ChannelSearch` used to open a search result with
 * `client.channel("messaging", id).watch()` on a browser-computed id. In
 * `stream-chat`, `watch()` posts to the channel **query** endpoint, which is the
 * same endpoint `create()` posts to — `channel.create()` is literally
 * `query({ created_by_id })`. So watching an id that did not exist created it,
 * with the caller as `created_by` and **no members**.
 *
 * The app paths that did that are gone, and `ensure-chat-type-grants.ts` revokes
 * `create-channel` from `user`/`guest` so Stream itself refuses. Neither helps
 * with the ones already on the app: a phantom is a real channel, it accepts real
 * messages, and it is billed like any other. Dev, preview and production share
 * one Stream app, so every environment's phantoms are in the same place.
 *
 * ## Why "< 2 members" is the right predicate
 *
 * A DM is a pair by construction. `getDmChannelId` refuses a self-pair and every
 * server-side creator passes both ids in the `members` array atomically, so a
 * healthy DM has exactly two. One member means the second was never added; zero
 * means it was created by `watch()`.
 *
 * `team` channels are deliberately out of scope. A webinar channel legitimately
 * sits at one member — its host — between creation and the first registration.
 *
 * ## Safety
 *
 * Dry run is the default and prints every candidate with its member count,
 * message count and age. `--apply` deletes, hard, in batches. A pre-image of
 * everything deleted is written first, to a stable path, so a mistake is
 * reconstructible.
 *
 *   npx tsx scripts/stream/purge-memberless-dms.ts
 *   npx tsx scripts/stream/purge-memberless-dms.ts --apply
 *   npx tsx scripts/stream/purge-memberless-dms.ts --apply --keep-with-messages
 *
 * NOTE: a dry run READS production. An apply DELETES from production.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  getStreamChatClient,
  isStreamConfigured,
} from "../../lib/stream-client";

/**
 * Stream caps `queryChannels` at 30 per call regardless of the `limit` passed.
 * A `do…while (page.length === PAGE_SIZE)` loop with PAGE_SIZE = 100 exits after
 * one page and silently processes only the first 30 — the bug that made
 * `syncUserEventChannels` reconcile a third of a roster. Page at the real cap.
 */
const PAGE_SIZE = 30;

/** Stream's documented ceiling for `deleteChannels`. */
const DELETE_BATCH = 100;

/** Where the pre-image goes. Stable, not pid-suffixed, so a later run finds it. */
const PRE_IMAGE_PATH = join(
  process.cwd(),
  ".stream-backups",
  "purged-memberless-dms.json",
);

interface Options {
  apply: boolean;
  /** Skip channels that hold messages, however broken they look. */
  keepWithMessages: boolean;
}

interface Candidate {
  cid: string;
  id: string;
  memberIds: string[];
  createdById?: string;
  createdAt?: string;
  lastMessageAt?: string;
}

function parseArgs(argv: string[]): Options {
  return {
    apply: argv.includes("--apply"),
    keepWithMessages: argv.includes("--keep-with-messages"),
  };
}

export async function purgeMemberlessDms(
  opts: Options,
): Promise<{ scanned: number; candidates: number; deleted: number }> {
  if (!isStreamConfigured()) {
    console.error(
      "Stream is not configured — set STREAM_API_KEY and STREAM_API_SECRET",
    );
    return { scanned: 0, candidates: 0, deleted: 0 };
  }

  const client = getStreamChatClient();
  const candidates: Candidate[] = [];
  let scanned = 0;
  let offset = 0;

  // Every `messaging` channel is walked and the member count checked here,
  // rather than filtered server-side. Stream's channel filters have no
  // `member_count` operator — `members: { $in: [...] }` needs ids we do not
  // have, and there is no "fewer than N members" query. So: page everything,
  // decide locally.
  for (;;) {
    const page = await client.queryChannels(
      { type: "messaging" },
      { created_at: 1 },
      { limit: PAGE_SIZE, offset, state: true, watch: false, presence: false },
    );
    if (page.length === 0) break;
    scanned += page.length;

    for (const channel of page) {
      const memberIds = Object.keys(channel.state?.members ?? {});
      if (memberIds.length >= 2) continue;

      const data = channel.data as Record<string, unknown> | undefined;
      const messageCount = channel.state?.messages?.length ?? 0;
      if (opts.keepWithMessages && messageCount > 0) continue;

      candidates.push({
        cid: channel.cid,
        id: channel.id ?? "",
        memberIds,
        createdById:
          typeof data?.created_by_id === "string"
            ? data.created_by_id
            : ((data?.created_by as { id?: string } | undefined)?.id ??
              undefined),
        createdAt:
          typeof data?.created_at === "string" ? data.created_at : undefined,
        lastMessageAt:
          typeof data?.last_message_at === "string"
            ? data.last_message_at
            : undefined,
      });
    }

    offset += page.length;
    if (page.length < PAGE_SIZE) break;
  }

  console.log(`Scanned ${scanned} messaging channels.`);
  console.log(`Found ${candidates.length} with fewer than 2 members:\n`);
  for (const c of candidates) {
    console.log(
      `  ${c.cid}\n` +
        `    members: ${c.memberIds.length === 0 ? "(none)" : c.memberIds.join(", ")}\n` +
        `    created_by: ${c.createdById ?? "unknown"}   created: ${c.createdAt ?? "?"}\n` +
        `    last_message_at: ${c.lastMessageAt ?? "never"}`,
    );
  }

  if (candidates.length === 0) return { scanned, candidates: 0, deleted: 0 };

  if (!opts.apply) {
    console.log(
      `\n(dry run — pass --apply to delete these ${candidates.length})`,
    );
    return { scanned, candidates: candidates.length, deleted: 0 };
  }

  // Written BEFORE the delete. Unlike the grants script — where the pre-image
  // only matters if a write succeeded — a delete is unrecoverable, so the
  // snapshot has to exist even if the delete then fails halfway.
  mkdirSync(dirname(PRE_IMAGE_PATH), { recursive: true });
  writeFileSync(PRE_IMAGE_PATH, JSON.stringify(candidates, null, 2));
  console.log(`\nPre-image written to ${PRE_IMAGE_PATH}`);

  let deleted = 0;
  for (let i = 0; i < candidates.length; i += DELETE_BATCH) {
    const batch = candidates.slice(i, i + DELETE_BATCH).map((c) => c.cid);
    await client.deleteChannels(batch, { hard_delete: true });
    deleted += batch.length;
    console.log(`  deleted ${deleted}/${candidates.length}`);
  }

  return { scanned, candidates: candidates.length, deleted };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(
    `Purging memberless DMs (${opts.apply ? "LIVE" : "DRY RUN"}` +
      `${opts.keepWithMessages ? ", keeping any with messages" : ""})...`,
  );
  const result = await purgeMemberlessDms(opts);
  console.log("\nDone:", result);
  process.exit(0);
}

if (
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module
) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
