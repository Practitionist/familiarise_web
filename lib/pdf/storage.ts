/**
 * Private finance-document storage — Supabase upload + signed URL.
 *
 * Thin domain wrapper around the `supabaseAdmin` singleton exported by
 * `lib/supabase.ts`. We don't go through the generic `uploadToSupabase`
 * helper because that one bundles upload + signed-URL generation in
 * one call (and hardcodes a 1h TTL); our flow needs to re-sign on
 * cache hits without re-uploading, with a 24h TTL that matches the
 * `pdfGeneratedAt` cache window on `OrganizationInvoice`.
 *
 * Bucket: `org-invoices` (private — must exist; create via the
 * Supabase dashboard or `ensureBucketExists` from lib/supabase.ts).
 * Path scheme for invoices: `<orgId>/<invoiceId>.pdf`. The orgId prefix
 * lets a future per-tenant Supabase token scope reads cleanly.
 *
 * #1354 — the invoice helpers below are now thin specializations of a
 * content-type-agnostic pair, because the quarterly TDS return CSV needs
 * exactly the same thing: the same private bucket, the same service-role
 * client, a signed URL with its own TTL. One module knows the bucket name.
 */

import { supabaseAdmin } from "@/lib/supabase";

const BUCKET = "org-invoices";
const SIGNED_URL_TTL_SECONDS = 24 * 60 * 60; // 24h — matches `pdfGeneratedAt` cache semantics

function requireAdminClient() {
  if (!supabaseAdmin) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is required to upload invoice PDFs. Add it to .env.local; see lib/supabase.ts for the warning printed at startup.",
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

export function pdfStoragePathFor(
  organizationId: string,
  invoiceId: string,
): string {
  return `${organizationId}/${invoiceId}.pdf`;
}

export async function uploadInvoicePdf(args: {
  storagePath: string;
  buffer: Buffer;
}): Promise<void> {
  // upsert=true so a regeneration on status change (REFUNDED / VOID)
  // overwrites the previous PDF rather than failing on conflict.
  await uploadPrivateFinanceObject({
    storagePath: args.storagePath,
    body: args.buffer,
    contentType: "application/pdf",
    cacheControl: "86400",
  });
}

export async function createInvoicePdfSignedUrl(
  storagePath: string,
): Promise<string> {
  return createPrivateFinanceSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
}
