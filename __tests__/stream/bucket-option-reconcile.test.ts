/**
 * @jest-environment node
 */

/**
 * `ensureBucketExists` used to apply its options only at CREATE time, so a
 * bucket that already existed kept whatever limits it was born with and the
 * options argument was silently ignored.
 *
 * The MIME arm is the one that actually bites in practice: Stream's external
 * storage probe uploads a `text/plain` file, and a bucket still carrying a
 * video-only allow-list rejects it with a 415 that reads like a credentials
 * failure rather than a config one.
 */
import {
  ALLOWED_FILE_MIME_TYPES,
  MAX_FILE_BYTES,
} from "@/lib/documents/file-policy";

const getBucket = jest.fn();
const updateBucket = jest.fn().mockResolvedValue({ error: null });
const list = jest.fn().mockResolvedValue({ data: [], error: null });

jest.mock("../../lib/supabase-storage-core", () => {
  const actual = jest.requireActual("../../lib/supabase-storage-core");
  return actual;
});

describe("ensureBucketExists option reconciliation", () => {
  const BUCKET = "documents";
  let ensureBucketExists: (
    name: string,
    options?: {
      public?: boolean;
      allowedMimeTypes?: string[];
      fileSizeLimit?: number;
    },
  ) => Promise<boolean>;

  beforeEach(async () => {
    jest.resetModules();
    getBucket.mockReset();
    updateBucket.mockReset().mockResolvedValue({ error: null });
    list.mockReset().mockResolvedValue({ data: [], error: null });

    jest.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({
        storage: { from: () => ({ list }), getBucket, updateBucket },
      }),
    }));

    ({ ensureBucketExists } = await import("../../lib/supabase-storage-core"));
  });

  const bucket = (over: Record<string, unknown> = {}) => ({
    data: {
      name: BUCKET,
      public: false,
      file_size_limit: MAX_FILE_BYTES,
      allowed_mime_types: [...ALLOWED_FILE_MIME_TYPES],
      ...over,
    },
  });

  it("widens a stale file size limit", async () => {
    getBucket.mockResolvedValue(bucket());
    await ensureBucketExists(BUCKET, { fileSizeLimit: 5368709120 });
    expect(updateBucket).toHaveBeenCalledWith(
      BUCKET,
      expect.objectContaining({ fileSizeLimit: 5368709120 }),
    );
  });

  it("reconciles a MIME-only change, with size and visibility already correct", async () => {
    getBucket.mockResolvedValue(bucket());
    await ensureBucketExists(BUCKET, {
      fileSizeLimit: MAX_FILE_BYTES,
      public: false,
      allowedMimeTypes: [
        ...ALLOWED_FILE_MIME_TYPES,
        "application/octet-stream",
      ],
    });
    expect(updateBucket).toHaveBeenCalledWith(
      BUCKET,
      expect.objectContaining({
        allowedMimeTypes: [
          ...ALLOWED_FILE_MIME_TYPES,
          "application/octet-stream",
        ],
      }),
    );
  });

  it("treats MIME order as insignificant", async () => {
    getBucket.mockResolvedValue(bucket());
    await ensureBucketExists(BUCKET, {
      allowedMimeTypes: [...ALLOWED_FILE_MIME_TYPES].reverse(),
    });
    expect(updateBucket).not.toHaveBeenCalled();
  });

  it("writes nothing when every option already matches", async () => {
    getBucket.mockResolvedValue(bucket());
    await ensureBucketExists(BUCKET, {
      public: false,
      fileSizeLimit: MAX_FILE_BYTES,
      allowedMimeTypes: [...ALLOWED_FILE_MIME_TYPES],
    });
    expect(updateBucket).not.toHaveBeenCalled();
  });

  it("still reconciles when the bucket is already memoized", async () => {
    getBucket.mockResolvedValue(bucket());
    // First caller supplies nothing, which is what puts it in the cache.
    await ensureBucketExists(BUCKET);
    expect(updateBucket).not.toHaveBeenCalled();

    // A later caller with real options must not be silently ignored.
    await ensureBucketExists(BUCKET, { fileSizeLimit: 5368709120 });
    expect(updateBucket).toHaveBeenCalledWith(
      BUCKET,
      expect.objectContaining({ fileSizeLimit: 5368709120 }),
    );
  });

  it("carries the bucket's own visibility through a size-only change", async () => {
    getBucket.mockResolvedValue(bucket());
    await ensureBucketExists(BUCKET, { fileSizeLimit: 5368709120 });
    // A size change must never flip a bucket public or private as a side effect.
    expect(updateBucket).toHaveBeenCalledWith(
      BUCKET,
      expect.objectContaining({ public: false }),
    );
  });

  it("does not fail the caller when the bucket cannot be widened", async () => {
    getBucket.mockResolvedValue(bucket());
    updateBucket.mockResolvedValue({
      error: { message: "exceeds plan limit" },
    });
    // The Free plan clamps objects to 50MB whatever the bucket says; a bucket
    // that cannot be widened is still a usable bucket.
    await expect(
      ensureBucketExists(BUCKET, { fileSizeLimit: 5368709120 }),
    ).resolves.toBe(true);
  });

  it("fails provisioning when the bucket's visibility cannot be read", async () => {
    getBucket.mockResolvedValue({
      data: null,
      error: { message: "forbidden" },
    });
    await expect(ensureBucketExists(BUCKET)).resolves.toBe(false);
  });

  it("fails provisioning when a visibility change cannot be applied", async () => {
    getBucket.mockResolvedValue(bucket({ public: true }));
    updateBucket.mockResolvedValueOnce({
      error: { message: "forbidden" },
    });
    await expect(ensureBucketExists(BUCKET, { public: false })).resolves.toBe(
      false,
    );
  });
});
