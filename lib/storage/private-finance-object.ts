/**
 * Private finance-document storage — upload, existence check and signed URL.
 *
 * #1354 — these three helpers started life inside `lib/pdf/storage.ts`, which
 * gets its client from `lib/supabase.ts`. That module opens with
 * `import "server-only"`, a marker package whose main entry does nothing but
 * `throw`, so any scheduled job whose import graph reaches it dies during
 * module evaluation before a line of its own code runs (#1270). The quarterly
 * TDS return export is exactly such a job: it writes its CSV from a bare
 * `tsx jobs/...` process.
 *
 * So the storage primitives live here instead, sourcing the admin client from
 * the marker-free `lib/supabase-storage-core.ts`. `lib/pdf/storage.ts`
 * re-exports every name below unchanged, so the request-scoped invoice callers
 * keep their `server-only` guard and no existing call site had to move.
 *
 * Bucket: `org-invoices` (private — must exist; create via the Supabase
 * dashboard or `ensureBucketExists`). It holds org invoice PDFs under
 * `<orgId>/<invoiceId>.pdf` and the TDS return CSVs under `compliance/tds/`.
 */

import { supabaseAdmin } from "@/lib/supabase-storage-core";

const BUCKET = "org-invoices";

function requireAdminClient() {
  if (!supabaseAdmin) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is required to read or write private finance documents. Add it to .env.local; see lib/supabase-storage-core.ts for the warning printed at startup.",
    );
  }
  return supabaseAdmin;
}

/**
 * Upload (or overwrite) an object in the private finance bucket.
 *
 * `upsert` is always on: every caller regenerates a document whose identity is
 * its path, so a re-run must replace rather than fail on conflict.
 */
export async function uploadPrivateFinanceObject(args: {
  storagePath: string;
  body: Buffer;
  contentType: string;
  /** Browser cache seconds; the bucket is private so this only affects the signed hop. */
  cacheControl?: string;
}): Promise<void> {
  const { error } = await requireAdminClient()
    .storage.from(BUCKET)
    .upload(args.storagePath, args.body, {
      contentType: args.contentType,
      cacheControl: args.cacheControl ?? "0",
      upsert: true,
    });

  if (error) {
    throw new Error(
      `Failed to upload ${args.storagePath} to ${BUCKET}: ${error.message}`,
    );
  }
}

/** True when the object exists; used to answer 404 before minting a URL. */
export async function privateFinanceObjectExists(
  storagePath: string,
): Promise<boolean> {
  const slash = storagePath.lastIndexOf("/");
  const dir = slash === -1 ? "" : storagePath.slice(0, slash);
  const name = storagePath.slice(slash + 1);
  const { data, error } = await requireAdminClient()
    .storage.from(BUCKET)
    .list(dir, { search: name });
  if (error) {
    throw new Error(
      `Failed to stat ${storagePath} in ${BUCKET}: ${error.message}`,
    );
  }
  // `search` is a prefix match, so confirm the exact name.
  return (data ?? []).some((o) => o.name === name);
}

export async function createPrivateFinanceSignedUrl(
  storagePath: string,
  ttlSeconds: number,
): Promise<string> {
  const { data, error } = await requireAdminClient()
    .storage.from(BUCKET)
    .createSignedUrl(storagePath, ttlSeconds);
  if (error || !data?.signedUrl) {
    throw new Error(
      `Failed to create signed URL for ${storagePath}: ${error?.message ?? "unknown"}`,
    );
  }
  return data.signedUrl;
}
