/**
 * @jest-environment node
 */

import {
  isR2Configured,
  createR2PresignedGetUrl,
  streamMultipartToR2,
  deleteR2Object,
} from "@/lib/storage/r2-client";

describe("lib/storage/r2-client", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      R2_S3_ENDPOINT: "https://test-account-123.r2.cloudflarestorage.com",
      R2_ACCESS_KEY_ID: "test-access-key",
      R2_SECRET_ACCESS_KEY: "test-secret-key",
      R2_BUCKET: "familiarise-recordings",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe("isR2Configured", () => {
    it("returns true when all required R2 credentials are set", () => {
      expect(isR2Configured()).toBe(true);
    });

    it("returns false when any required R2 credential is missing", () => {
      delete process.env.R2_SECRET_ACCESS_KEY;
      expect(isR2Configured()).toBe(false);
    });
  });

  describe("createR2PresignedGetUrl", () => {
    it("creates a valid SigV4 presigned GET URL", () => {
      const url = createR2PresignedGetUrl({
        key: "recordings/2026/03/rec-1.mp4",
        expiresInSeconds: 3600,
      });
      const parsed = new URL(url);
      expect(parsed.origin).toBe(
        "https://test-account-123.r2.cloudflarestorage.com",
      );
      expect(parsed.pathname).toBe(
        "/familiarise-recordings/recordings/2026/03/rec-1.mp4",
      );
      expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe(
        "AWS4-HMAC-SHA256",
      );
      expect(parsed.searchParams.get("X-Amz-Expires")).toBe("3600");
      expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(
        /^[0-9a-f]{64}$/,
      );
    });
  });

  describe("streamMultipartToR2", () => {
    it("uses single PUT when stream fits within a single part", async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => '"etag-single"' },
        text: async () => "",
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const chunk = new Uint8Array([10, 20, 30, 40]);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      });

      const result = await streamMultipartToR2({
        key: "recordings/small.mp4",
        stream,
        contentType: "video/mp4",
      });

      expect(result).toEqual({
        key: "recordings/small.mp4",
        size: 4,
        parts: 1,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        "https://test-account-123.r2.cloudflarestorage.com/familiarise-recordings/recordings/small.mp4",
      );
      expect(init.method).toBe("PUT");
    });

    it("executes S3 multipart upload when stream exceeds partSize", async () => {
      const fetchMock = jest
        .fn()
        // 1. CreateMultipartUpload
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            "<InitiateMultipartUploadResult><UploadId>upload-xyz</UploadId></InitiateMultipartUploadResult>",
        })
        // 2. UploadPart 1
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: (h: string) => (h === "etag" ? '"etag-1"' : null) },
          text: async () => "",
        })
        // 3. UploadPart 2
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: (h: string) => (h === "etag" ? '"etag-2"' : null) },
          text: async () => "",
        })
        // 4. CompleteMultipartUpload
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => "<CompleteMultipartUploadResult/>",
        });
      global.fetch = fetchMock as unknown as typeof fetch;

      const part1 = new Uint8Array(6 * 1024 * 1024);
      const part2 = new Uint8Array(1024);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(part1);
          controller.enqueue(part2);
          controller.close();
        },
      });

      const result = await streamMultipartToR2({
        key: "recordings/large.mp4",
        stream,
        contentType: "video/mp4",
        partSize: 5 * 1024 * 1024,
      });

      expect(result.size).toBe(part1.byteLength + part2.byteLength);
      expect(result.parts).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("rejects and aborts when CompleteMultipartUpload returns an error inside a 200", async () => {
      const ok = (body: string, etag: string | null = null) => ({
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h === "etag" ? etag : null) },
        text: async () => body,
      });
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(
          ok(
            "<InitiateMultipartUploadResult><UploadId>u-1</UploadId></InitiateMultipartUploadResult>",
          ),
        )
        .mockResolvedValueOnce(ok("", '"etag-1"'))
        .mockResolvedValueOnce(ok("", '"etag-2"'))
        .mockResolvedValueOnce(
          ok(
            "<Error><Code>InternalError</Code><Message>retry</Message></Error>",
          ),
        )
        .mockResolvedValueOnce(ok(""));
      global.fetch = fetchMock as unknown as typeof fetch;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(6 * 1024 * 1024));
          controller.enqueue(new Uint8Array(1024));
          controller.close();
        },
      });

      await expect(
        streamMultipartToR2({
          key: "recordings/err.mp4",
          stream,
          partSize: 5 * 1024 * 1024,
        }),
      ).rejects.toThrow(/CompleteMultipartUpload error InternalError/);
      expect((fetchMock.mock.calls[4][1] as RequestInit).method).toBe("DELETE");
    });

    it("aborts multipart upload if a part upload fails", async () => {
      const fetchMock = jest
        .fn()
        // 1. CreateMultipartUpload
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            "<InitiateMultipartUploadResult><UploadId>upload-fail</UploadId></InitiateMultipartUploadResult>",
        })
        // 2. UploadPart 1 fails
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          text: async () => "InternalError",
        })
        // 3. AbortMultipartUpload
        .mockResolvedValueOnce({
          ok: true,
          status: 204,
          text: async () => "",
        });
      global.fetch = fetchMock as unknown as typeof fetch;

      const part1 = new Uint8Array(6 * 1024 * 1024);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(part1);
          controller.close();
        },
      });

      await expect(
        streamMultipartToR2({
          key: "recordings/fail.mp4",
          stream,
          contentType: "video/mp4",
          partSize: 5 * 1024 * 1024,
        }),
      ).rejects.toThrow(/R2 UploadPart #1 failed/);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect((fetchMock.mock.calls[2][1] as RequestInit).method).toBe("DELETE");
    });
  });

  describe("deleteR2Object", () => {
    it("returns success on 204 and notFound on 404", async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 204,
          text: async () => "",
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          text: async () => "NoSuchKey",
        });
      global.fetch = fetchMock as unknown as typeof fetch;

      expect(await deleteR2Object({ key: "recordings/exists.mp4" })).toEqual({
        success: true,
      });
      expect(await deleteR2Object({ key: "recordings/missing.mp4" })).toEqual({
        success: true,
        notFound: true,
      });
    });
  });
});
