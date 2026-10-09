/**
 * Supabase storage clients and the two primitives every upload path needs.
 *
 * Split out of `lib/supabase.ts` for #1270. That module opens with
 * `import "server-only"`, which is a marker package whose main entry does
 * nothing but `throw` — Next resolves it to an empty module under the
 * `react-server` condition, and every other resolver gets the throw. A bare
 * `npx tsx jobs/...` process is "every other resolver", so ANY cron whose
 * import graph reached `lib/supabase.ts` died during module evaluation, before
 * a line of its own code ran.
 *
 * Five scheduled jobs reached it: mark-expired-recordings,
 * cleanup-old-stream-recordings, transfer-expiring-recordings and
 * sweep-stuck-webhook-events through `lib/stream/recording-transfer-service.ts`,
 * and purge-deleted-documents through `lib/documents/document-purge.ts`. None of
 * them has ever completed. Recordings past their org's retention window were
 * never tombstoned and the Supabase objects behind them were never deleted,
 * which is a DPDP erasure gap; permanent-storage transfers never ran, so
 * STREAM_ONLY recordings lapsed when Stream's fourteen-day URL expired; and the
 * sweep that re-drives stuck Stream webhook events was itself stuck.
 *
 * So this file carries no `server-only` marker. It holds the client
 * construction and the two helpers the crons need, and nothing that touches a
 * request, a session or a cookie. `lib/supabase.ts` re-exports every name below
 * unchanged and keeps its own marker, so application code still gets the
 * client-import guard and no call site had to move.
 */
import { createClient, SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL is not defined in environment variables.",
  );
}

// Every server-side storage call runs on the service-role client.
let supabaseAdminInstance: SupabaseClient | null = null;
if (supabaseServiceKey) {
  try {
    supabaseAdminInstance = createClient(supabaseUrl, supabaseServiceKey);
  } catch (error) {
    console.error("Error creating Supabase admin client:", error);
  }
} else {
  console.warn(
    "⚠️  SUPABASE_SERVICE_ROLE_KEY not found in environment variables — storage uploads, signed URLs and deletes will fail.",
  );
  console.warn(
    "   Get it from: Supabase Dashboard → Settings → API → service_role key (⚠️  Keep this secret!)",
  );
}

export const supabaseAdmin: SupabaseClient | null = supabaseAdminInstance;

/** The service-role storage API; throws when the key is not configured. */
export function adminStorage(): SupabaseClient["storage"] {
  if (!supabaseAdmin) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is required for storage operations.",
    );
  }
  return supabaseAdmin.storage;
}

/**
 * Centralized MIME type to file extension map.
 * Used by generateStorageFileName() to derive extensions from MIME types
 * instead of user-controlled file.name values.
 */
const MIME_TO_EXT: Record<string, string> = {
  // Images
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  // Documents
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
  "application/zip": "zip",
  "application/x-rar-compressed": "rar",
  // Video
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-msvideo": "avi",
  // Fallback
  "application/octet-stream": "bin",
};

/**
 * Generate a UUID-based storage filename with MIME-derived extension.
 * Guarantees uniqueness (UUID v4) and security (extension from MIME, not user input).
 */
export function generateStorageFileName(mimeType: string): string {
  const ext = MIME_TO_EXT[mimeType];
  if (!ext) throw new Error(`Unsupported MIME type: ${mimeType}`);
  return `${globalThis.crypto.randomUUID()}.${ext}`;
}

export interface BucketOptions {
  public?: boolean;
  allowedMimeTypes?: string[];
  fileSizeLimit?: number;
}

// Buckets proven to exist this process — skip the existence round-trip once seen.
const knownBuckets = new Set<string>();

/** Set equality for a small allow-list, without sorting. */
function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(b);
  return a.every((item) => seen.has(item));
}

/**
 * Bring an EXISTING bucket's settings up to the ones the caller asked for.
 *
 * `createBucket` only runs the first time, so before this the options argument
 * was silently ignored for every bucket that already existed — a bucket kept
 * whatever limits it was born with, and raising a caller's `fileSizeLimit` did
 * nothing at all. The recordings bucket sat at 500MB that way while the code
 * around it was changed to expect more (#1314).
 *
 * Best-effort on purpose: a bucket whose settings cannot be widened is still a
 * usable bucket, and failing the caller here would turn a config nicety into an
 * outage. Notably the Supabase FREE plan clamps every object to 50MB no matter
 * what the bucket says, so this call can legitimately succeed and change
 * nothing.
 */
async function reconcileBucketOptions(
  bucketName: string,
  options?: BucketOptions,
): Promise<void> {
  if (!options || !supabaseAdmin) return;

  const { data: bucket } = await supabaseAdmin.storage.getBucket(bucketName);
  if (!bucket) return;

  const wantsSize =
    options.fileSizeLimit !== undefined &&
    Number(bucket.file_size_limit ?? 0) !== options.fileSizeLimit;
  const wantsPublic =
    options.public !== undefined && bucket.public !== options.public;
  // A MIME-only drift is the one that actually bites: Stream's storage probe
  // uploads `text/plain`, and a bucket still carrying a video-only allow-list
  // rejects it with a 415 that reads like a credentials failure.
  //
  // Compared as sets rather than sorted lists. Order carries no meaning in an
  // allow-list, and sorting would invite Sonar's S2871 fix of `localeCompare` —
  // ICU collation is locale-dependent, so that can answer differently on CI
  // than on a laptop, which is exactly the bug class this repo bans it for.
  const wantsMime =
    options.allowedMimeTypes !== undefined &&
    !sameMembers(options.allowedMimeTypes, bucket.allowed_mime_types ?? []);
  if (!wantsSize && !wantsPublic && !wantsMime) return;

  // `public` is required by updateBucket, so carry the bucket's own value
  // through rather than flipping visibility as a side effect of a size change.
  const { error } = await supabaseAdmin.storage.updateBucket(bucketName, {
    public: options.public ?? bucket.public,
    ...(options.fileSizeLimit !== undefined
      ? { fileSizeLimit: options.fileSizeLimit }
      : {}),
    ...(options.allowedMimeTypes
      ? { allowedMimeTypes: options.allowedMimeTypes }
      : {}),
  });

  if (error) {
    console.warn(
      `Could not update bucket ${bucketName} settings: ${error.message}`,
    );
    return;
  }
  console.log(`Updated bucket ${bucketName} settings to match caller options`);
}

/**
 * Ensure a storage bucket exists, create it if it doesn't.
 * Pass options to customize bucket settings per use case.
 * Memoized per process: a bucket confirmed once is never re-probed.
 */
export const ensureBucketExists = async (
  bucketName: string,
  options?: BucketOptions,
): Promise<boolean> => {
  // Memoization skips the existence probe, not the settings. A later caller
  // passing options to a bucket already seen without them would otherwise be
  // silently ignored for the rest of the process.
  if (knownBuckets.has(bucketName)) {
    if (options) await reconcileBucketOptions(bucketName, options);
    return true;
  }
  try {
    const storage = adminStorage();
    // First check if bucket exists by trying to list files
    const { data: _files, error: listError } = await storage
      .from(bucketName)
      .list("", { limit: 1 });

    // If no error, bucket exists
    if (!listError) {
      await reconcileBucketOptions(bucketName, options);
      knownBuckets.add(bucketName);
      return true;
    }

    // If error is "Bucket not found", create the bucket
    if (
      listError.message.includes("Bucket not found") ||
      listError.message.includes("not found")
    ) {
      console.log(`Creating bucket: ${bucketName}`);

      const { data: _createData, error: createError } =
        await storage.createBucket(bucketName, {
          public: options?.public ?? true,
          allowedMimeTypes: options?.allowedMimeTypes ?? [
            "application/pdf",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "image/jpeg",
            "image/png",
            "image/gif",
            "text/plain",
          ],
          fileSizeLimit: options?.fileSizeLimit ?? 10485760, // 10MB
        });

      if (createError) {
        console.error(`Failed to create bucket ${bucketName}:`, createError);
        return false;
      }

      console.log(`Successfully created bucket: ${bucketName}`);
      knownBuckets.add(bucketName);
      return true;
    }

    // Other errors
    console.error(`Error checking bucket ${bucketName}:`, listError);
    return false;
  } catch (error) {
    console.error(`Unexpected error ensuring bucket ${bucketName}:`, error);
    return false;
  }
};

/**
 * Remove objects; true only when every path is gone afterwards. Storage's batch
 * delete answers with just the rows it removed, so each path missing from that
 * answer is re-checked and counts as removed only if it no longer exists.
 */
export const removeObjects = async (
  bucket: string,
  paths: string[],
): Promise<boolean> => {
  if (paths.length === 0) return true;
  try {
    const api = adminStorage().from(bucket);
    const { data, error } = await api.remove(paths);
    if (error) {
      console.error(`Storage remove failed in ${bucket}:`, error.message);
      return false;
    }
    const removed = new Set((data ?? []).map((object) => object.name));
    for (const path of paths) {
      if (removed.has(path)) continue;
      const { data: present } = await api.exists(path);
      if (present) {
        console.error(`Storage remove left ${bucket}/${path} in place`);
        return false;
      }
    }
    return true;
  } catch (error) {
    console.error(`Storage remove failed in ${bucket}:`, error);
    return false;
  }
};

/** Remove a single object. Never throws; false means the object may survive. */
export const deleteAsset = (
  bucket: string,
  storagePath: string,
): Promise<boolean> => removeObjects(bucket, [storagePath]);

/** Delete an appointment document; lives here so bare-Node cron processes can import it. */
export const deleteAppointmentDocument = (
  storagePath: string,
): Promise<boolean> => deleteAsset("documents", storagePath);
