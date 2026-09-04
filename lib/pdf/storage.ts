/**
 * PDF storage helpers — Supabase upload + signed URL for invoice PDFs.
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
 * Path scheme: `<orgId>/<invoiceId>.pdf`. The orgId prefix lets a
 * future per-tenant Supabase token scope reads cleanly.
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

export function pdfStoragePathFor(
  organizationId: string,
  invoiceId: string,
): string {
  return `${organizationId}/${invoiceId}.pdf`;
}

/**
 * Storage path for a consumer (B2C) invoice or credit-note PDF — #1365.
 *
 * Deliberately the SAME private bucket as the org documents, under a
 * `consumer/` prefix keyed by buyer. A second bucket would need its own
 * creation, its own policies and its own retention runbook to hold objects
 * with identical sensitivity and an identical access rule (signed URL, minted
 * only after the route has authorised the caller).
 */
export function consumerPdfStoragePathFor(
  userId: string,
  docId: string,
): string {
  return `consumer/${userId}/${docId}.pdf`;
}

export async function uploadInvoicePdf(args: {
  storagePath: string;
  buffer: Buffer;
}): Promise<void> {
  // upsert=true so a regeneration on status change (REFUNDED / VOID)
  // overwrites the previous PDF rather than failing on conflict.
  const { error } = await requireAdminClient()
    .storage.from(BUCKET)
    .upload(args.storagePath, args.buffer, {
      contentType: "application/pdf",
      cacheControl: "86400",
      upsert: true,
    });

  if (error) {
    throw new Error(`Failed to upload invoice PDF: ${error.message}`);
  }
}

export async function createInvoicePdfSignedUrl(
  storagePath: string,
): Promise<string> {
  const { data, error } = await requireAdminClient()
    .storage.from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    throw new Error(
      `Failed to create signed URL for invoice PDF: ${error?.message ?? "unknown"}`,
    );
  }
  return data.signedUrl;
}
