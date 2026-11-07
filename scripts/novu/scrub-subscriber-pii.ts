/**
 * One-time scrub of the profile data the old Novu mirror copied onto
 * subscribers: email, first and last name, phone, avatar and the `data`
 * preference flags. Postgres owns all of it now and the app sends none, so
 * Novu only needs the subscriber id. Run once per environment, then delete.
 *
 *   npx tsx scripts/novu/scrub-subscriber-pii.ts                     dry run, Development
 *   npx tsx scripts/novu/scrub-subscriber-pii.ts --apply             scrub Development
 *   npx tsx scripts/novu/scrub-subscriber-pii.ts --env production    dry run, Production
 *
 * A dry run READS the environment and prints counts and field names only,
 * never values. An apply WRITES each subscriber.
 */
import "dotenv/config";

import { Novu } from "@novu/api";
import type {
  PatchSubscriberRequestDto,
  SubscriberResponseDto,
} from "@novu/api/models/components";
import {
  resolveNovuSecretKey,
  type NovuEnvironment,
} from "../../lib/novu/secret-key";

const PAGE_SIZE = 100;

/** The profile fields the old mirror wrote; each is cleared with null. */
export const PII_FIELDS = [
  "email",
  "firstName",
  "lastName",
  "phone",
  "avatar",
  "data",
] as const;
type PiiField = (typeof PII_FIELDS)[number];

type SubscriberRow = Pick<SubscriberResponseDto, "subscriberId" | PiiField>;

/** The slice of the Novu SDK this script uses. */
export interface NovuSubscriberApi {
  subscribers: {
    search(request: { limit: number; after?: string }): Promise<{
      result: { data: SubscriberRow[]; next?: string | null };
    }>;
    patch(
      dto: PatchSubscriberRequestDto,
      subscriberId: string,
    ): Promise<unknown>;
  };
}

export interface ScrubResult {
  scanned: number;
  withPii: number;
  /** How many subscribers carried each field. */
  fieldCounts: Record<PiiField, number>;
  scrubbed: number;
  failures: Array<{ subscriberId: string; error: string }>;
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** The fields this subscriber still carries. */
export function piiFieldsOf(row: SubscriberRow): PiiField[] {
  return PII_FIELDS.filter((field) => hasValue(row[field]));
}

/** Lists every subscriber and, only with `apply`, nulls the mirrored fields. */
export async function scrubSubscriberPii(
  novu: NovuSubscriberApi,
  opts: { apply: boolean },
): Promise<ScrubResult> {
  const result: ScrubResult = {
    scanned: 0,
    withPii: 0,
    fieldCounts: Object.fromEntries(PII_FIELDS.map((f) => [f, 0])) as Record<
      PiiField,
      number
    >,
    scrubbed: 0,
    failures: [],
  };
  let after: string | undefined;
  do {
    const page = await novu.subscribers.search({
      limit: PAGE_SIZE,
      ...(after ? { after } : {}),
    });
    for (const row of page.result.data) {
      result.scanned += 1;
      const fields = piiFieldsOf(row);
      if (fields.length === 0) continue;
      result.withPii += 1;
      for (const field of fields) result.fieldCounts[field] += 1;
      if (!opts.apply) continue;
      try {
        await novu.subscribers.patch(
          Object.fromEntries(fields.map((f) => [f, null])),
          row.subscriberId,
        );
        result.scrubbed += 1;
      } catch (error) {
        result.failures.push({
          subscriberId: row.subscriberId,
          error: error instanceof Error ? error.message : String(error),
        });
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
    `Scrubbing mirrored subscriber profile data with ${name} (${apply ? "LIVE" : "DRY RUN"})...`,
  );
  const result = await scrubSubscriberPii(new Novu({ secretKey: key }), {
    apply,
  });
  console.log(
    `\nScanned ${result.scanned} subscriber(s); ${result.withPii} still carry mirrored data.`,
  );
  for (const field of PII_FIELDS) {
    console.log(`  ${field.padEnd(10)} ${result.fieldCounts[field]}`);
  }
  if (apply) console.log(`\nScrubbed ${result.scrubbed}.`);
  for (const failure of result.failures) {
    console.error(`  failed ${failure.subscriberId}: ${failure.error}`);
  }
  if (!apply && result.withPii > 0) {
    console.log("\nRe-run with --apply to clear these fields.");
  }
  if (result.failures.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
