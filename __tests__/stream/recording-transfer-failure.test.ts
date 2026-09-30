/**
 * @jest-environment node
 */

/**
 * STR-2/3 — transfer-failure tracking + threshold alerting. On every failed
 * transfer the Recording row gets transferAttempts++ and lastTransferError set;
 * once attempts reach the alert threshold (>=3) and we haven't paged before
 * (transferFailureAlertedAt null), recordSystemError fires once and the dedupe
 * marker is stamped. A subsequent failure with the marker already set does NOT
 * re-page.
 *
 * D1 changed the shape of that write, and the reason it changed is the bulk of
 * what is asserted below. Every status write in the transfer service is now a
 * conditional `updateMany` fenced on the state the attempt actually claimed,
 * with `count === 0` read as a lost race rather than a retryable failure:
 *
 *   - the claim  `READY` + `STREAM_S3`            → `TRANSFERRING`
 *   - the revert `TRANSFERRING` + `STREAM_S3`     → `READY` / `FAILED`
 *   - the store  `TRANSFERRING` + `STREAM_S3`     → `AVAILABLE` + `PLATFORM`
 *
 * The three writers they exclude (`markExpiredRecordings`, the retention
 * tombstone, and this service's own 2-hour stale sweep) all hold DIFFERENT cron
 * lock keys, so a bare `update({ where: { id } })` excluded nothing. The damage
 * was a resurrection in both directions: a late failure putting a genuinely
 * EXPIRED row back to READY so `getBestRecordingUrl` served a dead Stream URL,
 * and a retention tombstone being overwritten by a completing transfer, which
 * left a row past its retention window pointing at bytes the sweep had never
 * deleted — a DPDP violation, and permanently invisible to the sweep's own
 * candidate filter.
 *
 * D2 (deterministic object key), D3 (bounded download + a size guard that is not
 * a no-op) and D7 (reset the attempt counter on recovery) are covered here too,
 * because they are the same write path.
 */

const mockUpdateMany = jest.fn();
const mockUpdate = jest.fn();
const mockFindUnique = jest.fn();
const mockFindMany = jest.fn();
const mockCount = jest.fn();
const mockOrgAuditLogCreate = jest.fn();
const mockTxUpdateMany = jest.fn();
const mockTxOrgAuditLogCreate = jest.fn();
const mockDeleteRecordingObject = jest.fn();

jest.mock("../../lib/prisma", () => {
  // Every reference is an arrow, not a direct capture: `jest.mock` is hoisted
  // above the `const` declarations, so a factory that dereferenced one at
  // module-init time would hit the temporal dead zone.
  const tx = {
    recording: {
      updateMany: (...a: unknown[]) => mockTxUpdateMany(...a),
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
    },
    orgAuditLog: { create: (...a: unknown[]) => mockTxOrgAuditLogCreate(...a) },
  };
  const client = {
    recording: {
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
      update: (...a: unknown[]) => mockUpdate(...a),
      updateMany: (...a: unknown[]) => mockUpdateMany(...a),
      findMany: (...a: unknown[]) => mockFindMany(...a),
      count: (...a: unknown[]) => mockCount(...a),
    },
    orgAuditLog: { create: (...a: unknown[]) => mockOrgAuditLogCreate(...a) },
    $transaction: (fn: (t: typeof tx) => unknown) => Promise.resolve(fn(tx)),
  };
  return { __esModule: true, default: client };
});
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));
jest.mock("../../lib/enterprise/system-events", () => {
  const recordSystemError = jest.fn().mockResolvedValue(undefined);
  return {
    recordSystemError,
    recordSystemErrorSafe: recordSystemError,
    recordSystemEvent: jest.fn().mockResolvedValue(undefined),
  };
});
// Only the StorageObject removal is exercised from here; the audit writes are
// asserted through the prisma mock above.
jest.mock("../../lib/stream/recording-storage", () => ({
  RECORDINGS_BUCKET: "recordings",
  // 1MiB, not the production 5GiB: the ceiling assertions need a body that
  // crosses it without allocating gigabytes. The production value's own
  // contract is asserted in recording-object-ceiling.test.ts.
  RECORDING_MAX_OBJECT_BYTES: 1024 * 1024,
  RECORDING_MIME_TYPES: [
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/x-msvideo",
    "application/octet-stream",
  ],
  storageClient: {
    storage: {
      from: () => ({
        upload: (path: string, body: ReadableStream<Uint8Array> | Blob) =>
          mockUpload(path, body),
      }),
    },
  },
  deleteRecordingObject: (...a: unknown[]) => mockDeleteRecordingObject(...a),
}));
// #1270 — the service reads the clients from the leaf module now, not from
// `lib/supabase`. That one carries an `import "server-only"` marker, which
// throws outside Next's `react-server` resolution and so cannot be reached from
// a cron process at all.
jest.mock("../../lib/supabase-storage-core", () => ({
  __esModule: true,
  supabase: { storage: {} },
  supabaseAdmin: { storage: {} },
  ensureBucketExists: jest.fn().mockResolvedValue(true),
  generateStorageFileName: jest.fn().mockReturnValue("file.mp4"),
}));
// The delete path constructs a Stream client lazily; nothing else here does.
jest.mock("../../lib/stream-client", () => ({
  getStreamVideoClient: () => ({
    video: {
      call: () => ({ listRecordings: jest.fn(), deleteRecording: jest.fn() }),
    },
  }),
  withStreamCircuitBreaker: (fn: () => unknown) => fn(),
}));

import { recordSystemError } from "../../lib/enterprise/system-events";
import { RecordingTransferService } from "../../lib/stream/recording-transfer-service";

const mockRecordSystemError = recordSystemError as jest.Mock;
/**
 * Stands in for the storage upload. Drains the body, which is what the real
 * client does and what makes the byte counter meaningful — a mock that resolves
 * without reading would leave `capped.bytes` at 0 and `fileSize` stamped 0.
 */
type UploadResult = { error: { message: string } | null };
const mockUpload = jest.fn<
  Promise<UploadResult>,
  [string, ReadableStream<Uint8Array> | Blob]
>(async (_path, body) => {
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
  return { error: null };
});

/**
 * The failure-revert write — the one with `transferAttempts` in its data. It
 * goes through the transaction client, not the global one, because
 * `recordTransferFailure` needs the CAS and the post-write counters to be
 * consistent with each other.
 */
const failureWrite = () =>
  mockTxUpdateMany.mock.calls.find(([arg]) => arg.data?.transferAttempts);

/** The success write — the one that carries `storagePath`. */
const successWrite = () =>
  mockUpdateMany.mock.calls.find(([arg]) => arg.data?.storagePath);

const bytes = (n: number) => new Uint8Array(n);

beforeEach(() => {
  // `mockReset`, not just `clearAllMocks`: a `mockResolvedValueOnce` left
  // unconsumed by an earlier test (a fence that was never reached, say) would
  // otherwise become the default for the next one — which is how a test that
  // asserts a CAS quietly stops asserting anything.
  for (const m of [
    mockUpdateMany,
    mockUpdate,
    mockFindUnique,
    mockFindMany,
    mockCount,
    mockTxUpdateMany,
    mockOrgAuditLogCreate,
    mockTxOrgAuditLogCreate,
    mockDeleteRecordingObject,
    mockUpload,
  ]) {
    m.mockReset();
  }
  mockDeleteRecordingObject.mockResolvedValue({ success: true });
  mockUpload.mockImplementation(async (_path, body) => {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    return { error: null };
  });
  mockTxOrgAuditLogCreate.mockResolvedValue({});
  mockOrgAuditLogCreate.mockResolvedValue({});
  // Download fails → exercises the recordTransferFailure path without needing
  // a real blob/upload pipeline.
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status: 502,
    statusText: "Bad Gateway",
  }) as unknown as typeof fetch;
});

describe("transfer failure tracking (STR-2/3)", () => {
  it("increments transferAttempts and sets lastTransferError on failure", async () => {
    mockFindUnique.mockResolvedValue({
      id: "rec_1",
      recordingUrl: "https://stream.example/rec_1.mp4",
    });
    // The claim write succeeds; the failure write (through the transaction
    // client) succeeds and the follow-up read returns the post-increment
    // counters.
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockTxUpdateMany.mockResolvedValue({ count: 1 });
    mockUpdate.mockResolvedValue({});

    const res =
      await RecordingTransferService.transferRecordingToSupabase("rec_1");

    expect(res.success).toBe(false);
    const failure = failureWrite();
    expect(failure).toBeDefined();
    expect(failure![0].data).toMatchObject({
      status: "READY",
      transferAttempts: { increment: 1 },
    });
    expect(failure![0].data.lastTransferError).toContain("502");
    // Below threshold → no page.
    expect(mockRecordSystemError).not.toHaveBeenCalled();
  });

  it("pages once when attempts cross the threshold and stamps the dedupe marker", async () => {
    mockFindUnique.mockImplementation(() =>
      Promise.resolve({
        id: "rec_1",
        recordingUrl: "https://stream.example/rec_1.mp4",
        organizationId: "org_1",
        transferAttempts: 3, // crosses the >=3 threshold
        transferFailureAlertedAt: null,
      }),
    );
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockTxUpdateMany.mockResolvedValue({ count: 1 });
    mockUpdate.mockResolvedValue({});

    await RecordingTransferService.transferRecordingToSupabase("rec_1");

    expect(mockRecordSystemError).toHaveBeenCalledTimes(1);
    expect(mockRecordSystemError).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_1",
        category: "RECORDING_TRANSFER",
        correlationId: "rec_1",
      }),
    );
    // Dedupe marker stamped after the page.
    const stamp = mockUpdate.mock.calls.find(
      ([arg]) => arg.data?.transferFailureAlertedAt instanceof Date,
    );
    expect(stamp).toBeDefined();
  });

  it("does NOT re-page when already alerted (dedupe)", async () => {
    mockFindUnique.mockResolvedValue({
      id: "rec_1",
      recordingUrl: "https://stream.example/rec_1.mp4",
      organizationId: "org_1",
      transferAttempts: 5,
      transferFailureAlertedAt: new Date("2026-06-15T00:00:00.000Z"),
    });
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockTxUpdateMany.mockResolvedValue({ count: 1 });
    mockUpdate.mockResolvedValue({});

    await RecordingTransferService.transferRecordingToSupabase("rec_1");

    expect(mockRecordSystemError).not.toHaveBeenCalled();
  });
});

describe("D1 — every status write is fenced, and count === 0 is a lost race", () => {
  it("claims the row conditionally on READY + STREAM_S3", async () => {
    mockFindUnique.mockResolvedValue({
      id: "rec_1",
      recordingUrl: "https://stream.example/rec_1.mp4",
    });
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockUpdate.mockResolvedValue({});

    await RecordingTransferService.transferRecordingToSupabase("rec_1");

    const claim = mockUpdateMany.mock.calls[0][0];
    expect(claim.where).toMatchObject({ id: "rec_1", status: "READY" });
    expect(claim.where).toMatchObject({ storageType: "STREAM_S3" });
    expect(claim.data).toEqual({ status: "TRANSFERRING" });
  });

  it("refuses to transfer when the claim loses the race", async () => {
    mockFindUnique.mockResolvedValue({
      id: "rec_1",
      recordingUrl: "https://stream.example/rec_1.mp4",
    });
    // Someone else owns the row.
    mockUpdateMany.mockResolvedValue({ count: 0 });

    const res =
      await RecordingTransferService.transferRecordingToSupabase("rec_1");

    expect(res).toEqual({
      success: false,
      error: "Recording is not in a transferable state",
    });
    // Nothing was downloaded — the claim is the gate, not a formality.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fences the failure revert on TRANSFERRING, so a late failure cannot resurrect EXPIRED", async () => {
    mockFindUnique.mockResolvedValue({
      id: "rec_1",
      recordingUrl: "https://stream.example/rec_1.mp4",
    });
    // The claim wins; the revert finds the row already EXPIRED (the expiry
    // sweep, or the retention tombstone, got there first).
    mockUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    mockUpdate.mockResolvedValue({});

    const res =
      await RecordingTransferService.transferRecordingToSupabase("rec_1");

    expect(res.success).toBe(false);
    const revert = failureWrite()!;
    expect(revert[0].where).toMatchObject({
      id: "rec_1",
      status: "TRANSFERRING",
      storageType: "STREAM_S3",
    });
    // And the counters were not read, because the row is no longer ours: no
    // `findUnique` inside the transaction, so no page decision was made from
    // another writer's row.
    expect(mockRecordSystemError).not.toHaveBeenCalled();
  });

  it("discards the object when the success write loses the race", async () => {
    mockFindUnique.mockResolvedValue({
      id: "rec_1",
      recordingUrl: "https://stream.example/rec_1.mp4",
      recordedAt: new Date("2026-03-04T10:00:00.000Z"),
      storagePath: null,
    });
    // Claim wins, success write loses — the row was tombstoned mid-transfer.
    mockUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({
      count: 0,
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (k: string) =>
          k === "content-type"
            ? "video/mp4"
            : k === "content-length"
              ? "1024"
              : null,
      },
      body: new ReadableStream({
        start(c) {
          c.enqueue(bytes(1024));
          c.close();
        },
      }),
    }) as unknown as typeof fetch;

    const res =
      await RecordingTransferService.transferRecordingToSupabase("rec_1");

    // Not a success, and NOT counted as a fault by the sweep — see `retired`.
    expect(res.success).toBe(false);
    expect(res.retired).toBe(true);
    const store = successWrite()!;
    expect(store[0].where).toMatchObject({
      id: "rec_1",
      status: "TRANSFERRING",
      storageType: "STREAM_S3",
    });
    // The object the losing transfer just wrote is removed rather than orphaned
    // in the bucket pointing at nothing.
    expect(mockDeleteRecordingObject).toHaveBeenCalledWith(
      store[0].data.storagePath,
    );
  });

  it("tallies a retired row separately from a failure", async () => {
    mockFindMany.mockResolvedValue([]);
    mockCount.mockResolvedValue(0);
    mockUpdateMany.mockResolvedValue({ count: 0 });

    const out = await RecordingTransferService.processExpiringRecordings(14);

    // A clean sweep with a retirement is not a failing sweep.
    expect(out).toMatchObject({
      processed: 0,
      succeeded: 0,
      failed: 0,
      retired: 0,
    });
  });
});

describe("D2 — the object key is derived from the row, so a retry reuses it", () => {
  const okStream = (contentLength: string | null, body: ReadableStream) =>
    (global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (k: string) =>
          k === "content-type"
            ? "video/mp4"
            : k === "content-length"
              ? contentLength
              : null,
      },
      body,
    }) as unknown as typeof fetch);

  const oneChunk = (n: number) =>
    new ReadableStream({
      start(c) {
        c.enqueue(bytes(n));
        c.close();
      },
    });

  const runAttempt = async (row: Record<string, unknown>) => {
    mockFindUnique.mockResolvedValue(row);
    mockUpdateMany.mockResolvedValue({ count: 1 });
    okStream("1024", oneChunk(1024));
    await RecordingTransferService.transferRecordingToSupabase("rec_1");
    return successWrite()![0].data.storagePath as string;
  };

  it("writes the same path on a retry, so upsert dedupes instead of orphaning", async () => {
    const row = {
      id: "rec_1",
      recordingUrl: "https://stream.example/rec_1.mp4",
      recordedAt: new Date("2026-03-04T10:00:00.000Z"),
      storagePath: null,
    };
    const first = await runAttempt(row);
    // The 2-hour stale-TRANSFERRING sweep reset the row and relaunched it; the
    // row's only change is that it is READY again.
    const second = await runAttempt({ ...row, storagePath: null });

    expect(second).toBe(first);
    expect(first).toBe("recordings/2026/03/rec_1/recording.mp4");
    // No uuid in the key — the old name was `<uuid>.<ext>`, which is what left
    // an orphan object behind on every relaunch.
    expect(first).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
  });

  it("keys off recordedAt in UTC, not the wall clock", async () => {
    const path = await runAttempt({
      id: "rec_1",
      recordingUrl: "https://stream.example/rec_1.mp4",
      // 23:30 UTC on the 31st — a local-timezone key would roll the month on
      // half the fleet and the same recording would get two keys.
      recordedAt: new Date("2026-01-31T23:30:00.000Z"),
      storagePath: null,
    });
    expect(path).toBe("recordings/2026/01/rec_1/recording.mp4");
  });

  it("reuses the extension already on the row when the content type changes", async () => {
    mockFindUnique.mockResolvedValue({
      id: "rec_1",
      recordingUrl: "https://stream.example/rec_1.mp4",
      recordedAt: new Date("2026-03-04T10:00:00.000Z"),
      // A previous attempt recorded a webm key; a retry served octet-stream.
      storagePath: "recordings/2026/03/rec_1/recording.webm",
    });
    mockUpdateMany.mockResolvedValue({ count: 1 });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (k: string) =>
          k === "content-type"
            ? "application/octet-stream"
            : k === "content-length"
              ? "1024"
              : null,
      },
      body: oneChunk(1024),
    }) as unknown as typeof fetch;

    await RecordingTransferService.transferRecordingToSupabase("rec_1");

    expect(successWrite()![0].data.storagePath).toBe(
      "recordings/2026/03/rec_1/recording.webm",
    );
  });

  it("resets transferAttempts on recovery, so the next single failure does not re-page", async () => {
    mockFindUnique.mockResolvedValue({
      id: "rec_1",
      recordingUrl: "https://stream.example/rec_1.mp4",
      recordedAt: new Date("2026-03-04T10:00:00.000Z"),
      storagePath: null,
      transferAttempts: 5,
    });
    mockUpdateMany.mockResolvedValue({ count: 1 });
    okStream("1024", oneChunk(1024));

    await RecordingTransferService.transferRecordingToSupabase("rec_1");

    expect(successWrite()![0].data.transferAttempts).toBe(0);
    expect(successWrite()![0].data.lastTransferError).toBeNull();
    expect(successWrite()![0].data.transferFailureAlertedAt).toBeNull();
  });
});

describe("D3 — the download is bounded and the size guard is not a no-op", () => {
  const withHeaders = (
    contentLength: string | null,
    body: ReadableStream,
    contentType = "video/mp4",
  ) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (k: string) =>
          k === "content-type"
            ? contentType
            : k === "content-length"
              ? contentLength
              : null,
      },
      body,
    }) as unknown as typeof fetch;
  };

  const oneChunk = (n: number) =>
    new ReadableStream({
      start(c) {
        c.enqueue(bytes(n));
        c.close();
      },
    });

  beforeEach(() => {
    mockFindUnique.mockResolvedValue({
      id: "rec_1",
      recordingUrl: "https://stream.example/rec_1.mp4",
      recordedAt: new Date("2026-03-04T10:00:00.000Z"),
      storagePath: null,
    });
    mockUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("passes an AbortSignal, so a hung socket cannot pin the cron lock", async () => {
    withHeaders("1024", oneChunk(1024));

    await RecordingTransferService.transferRecordingToSupabase("rec_1");

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.signal).toBeDefined();
  });

  it("counts the stream and stamps fileSize when there is no content-length", async () => {
    // The case the old `if (fileSizeNumber && …)` guard skipped entirely — and
    // therefore the case most likely to hit the Supabase FREE plan's 50MB clamp.
    withHeaders(null, oneChunk(4096));

    const res =
      await RecordingTransferService.transferRecordingToSupabase("rec_1");

    expect(res.success).toBe(true);
    expect(successWrite()![0].data.fileSize).toBe(BigInt(4096));
  });

  it("fails terminally when an undeclared body passes the ceiling", async () => {
    // No content-length, and the body is larger than the mocked 1MiB ceiling.
    // The counting TransformStream errors the stream mid-upload, which is the
    // only way to catch this shape: the old guard could not see it at all.
    withHeaders(null, oneChunk(2 * 1024 * 1024));

    const res =
      await RecordingTransferService.transferRecordingToSupabase("rec_1");

    expect(res.success).toBe(false);
    // Not reverted to READY: this object can never fit, so retrying it every
    // six hours is the silent infinite loop D3 describes.
    expect(failureWrite()![0].data.status).toBe("FAILED");
    // And nothing was recorded as a success.
    expect(successWrite()).toBeUndefined();
  });

  it("terminates a declared oversize before spending the upload", async () => {
    withHeaders(String(2 * 1024 * 1024), oneChunk(1024));

    const res =
      await RecordingTransferService.transferRecordingToSupabase("rec_1");

    expect(res.success).toBe(false);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(failureWrite()![0].data.status).toBe("FAILED");
  });

  it("terminates on a bucket-level size rejection", async () => {
    // The Supabase FREE plan clamps every object to 50MB regardless of the
    // bucket setting, so this is the rejection a long session actually gets.
    withHeaders("1024", oneChunk(1024));
    mockUpload.mockResolvedValue({
      error: { message: "The object exceeded the maximum allowed size" },
    });

    await RecordingTransferService.transferRecordingToSupabase("rec_1");

    expect(failureWrite()![0].data.status).toBe("FAILED");
  });

  it("still reverts a transient storage fault to READY", async () => {
    // The counterpart to the case above: a 5xx is not a size verdict, and
    // misclassifying one as terminal would strand a recording a blip could
    // have saved.
    withHeaders("1024", oneChunk(1024));
    mockUpload.mockResolvedValue({ error: { message: "Internal error" } });

    await RecordingTransferService.transferRecordingToSupabase("rec_1");

    expect(failureWrite()![0].data.status).toBe("READY");
  });
});

describe("D7 — the sweeps are bounded", () => {
  beforeEach(() => {
    mockCount.mockResolvedValue(0);
    mockUpdateMany.mockResolvedValue({ count: 0 });
  });

  it("caps the transfer batch at 25, not 10", async () => {
    mockFindMany.mockResolvedValue([]);

    await RecordingTransferService.processExpiringRecordings(14);

    const call = mockFindMany.mock.calls[0][0];
    expect(call.take).toBe(25);
    // And the sweep only reads ids — every other column was pure transfer cost.
    expect(call.select).toEqual({ id: true });
  });

  it("bounds and projects the STREAM_ONLY warning sweep", async () => {
    mockFindMany.mockResolvedValue([]);

    await RecordingTransferService.getExpiringStreamOnlyRecordings(3);

    const call = mockFindMany.mock.calls[0][0];
    expect(call.take).toBe(500);
    expect(call.orderBy).toEqual({ streamUrlExpiresAt: "asc" });
    // A select, not the five-arm `include` that pulled two full consultant
    // profiles per row for four output fields.
    expect(call.include).toBeUndefined();
    expect(call.select).toBeDefined();
  });

  it("matches STREAM_ONLY across all four plan arms", async () => {
    mockFindMany.mockResolvedValue([]);

    await RecordingTransferService.getExpiringStreamOnlyRecordings(3);

    const arms =
      mockFindMany.mock.calls[0][0].where.meeting.occurrence.appointment.OR;
    expect(arms).toHaveLength(4);
    expect(JSON.stringify(arms)).toContain("consultationPlan");
    expect(JSON.stringify(arms)).toContain("subscriptionPlan");
  });
});

describe("D6 — delete removes the object before the row, and always audits", () => {
  it("refuses to tombstone when the storage delete fails", async () => {
    mockFindUnique.mockResolvedValue({
      id: "rec_1",
      title: "Session",
      storagePath: "recordings/2026/03/rec_1/recording.mp4",
      streamCallId: null,
      organizationId: "org_1",
      meeting: { id: "m_1" },
    });
    mockDeleteRecordingObject.mockResolvedValue({
      success: false,
      error: "bucket offline",
    });

    const res = await RecordingTransferService.deleteRecording("rec_1");

    expect(res.success).toBe(false);
    // The row must NOT be flipped: an EXPIRED row pointing at bytes still in
    // the bucket is the exact orphan the DPDP gap is about.
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(mockOrgAuditLogCreate).not.toHaveBeenCalled();
  });

  it("404s an unknown recording without writing an audit row claiming a delete", async () => {
    mockFindUnique.mockResolvedValue(null);

    const res = await RecordingTransferService.deleteRecording("nope");

    expect(res).toMatchObject({ success: false, error: "Recording not found" });
    expect(mockOrgAuditLogCreate).not.toHaveBeenCalled();
  });

  it("tombstones and audits once the object is gone", async () => {
    mockFindUnique.mockResolvedValue({
      id: "rec_1",
      title: "Session",
      storagePath: "recordings/2026/03/rec_1/recording.mp4",
      streamCallId: null,
      organizationId: "org_1",
      meeting: { id: "m_1" },
    });
    mockUpdateMany.mockResolvedValue({ count: 1 });

    const res = await RecordingTransferService.deleteRecording("rec_1");

    expect(res).toMatchObject({ success: true, storageDeleted: true });
    const flip = mockUpdateMany.mock.calls[0][0];
    expect(flip.data).toMatchObject({
      status: "EXPIRED",
      storagePath: null,
      storageType: "STREAM_S3",
    });
    expect(mockOrgAuditLogCreate).toHaveBeenCalledTimes(1);
    expect(mockOrgAuditLogCreate.mock.calls[0][0].data).toMatchObject({
      organizationId: "org_1",
      details: { recordingId: "rec_1", source: "operator-delete" },
    });
  });

  // #1829 — the fence. The storage delete above is a NETWORK call against a
  // value read before it, and a transfer can complete inside that window:
  //
  //   1. findUnique reads `storagePath: null` (a transfer is in flight).
  //   2. The transfer's fenced success write sets `storagePath`, `PLATFORM` and
  //      `AVAILABLE`, and the object is now in our bucket.
  //   3. An id-only tombstone clears `storagePath` and writes EXPIRED.
  //
  // The object the transfer just uploaded is now unreachable: the row says
  // there is nothing in storage, so no sweep will ever delete it, and it
  // outlives whatever retention this delete was invoked to enforce. Same orphan
  // class the retention sweep fix exists to close, reachable from another door.
  it("fences the tombstone on the storagePath it READ, not the id alone", async () => {
    mockFindUnique.mockResolvedValue({
      id: "rec_1",
      title: "Session",
      storagePath: "recordings/2026/03/rec_1/recording.mp4",
      streamCallId: null,
      organizationId: "org_1",
      meeting: { id: "m_1" },
    });
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await RecordingTransferService.deleteRecording("rec_1");

    // The exact value read, so a row that MOVED under us matches zero rows and
    // the caller re-reads rather than tombstoning a row it no longer
    // understands.
    expect(mockUpdateMany.mock.calls[0][0].where).toEqual({
      id: "rec_1",
      storagePath: "recordings/2026/03/rec_1/recording.mp4",
    });
  });

  it("fences on a NULL storagePath too — the in-flight-transfer case", async () => {
    // A row with no path yet is exactly the one a transfer is about to fill in.
    // `storagePath: null` in the WHERE is a real predicate in Prisma, so this
    // reads as IS NULL and catches the row — but the point is that it is
    // EXPLICIT: the id-only form would also match a row a transfer had just
    // completed, which is the bug.
    mockFindUnique.mockResolvedValue({
      id: "rec_1",
      title: "Session",
      storagePath: null,
      streamCallId: null,
      organizationId: "org_1",
      meeting: { id: "m_1" },
    });
    mockUpdateMany.mockResolvedValue({ count: 0 });

    const res = await RecordingTransferService.deleteRecording("rec_1");

    expect(mockUpdateMany.mock.calls[0][0].where).toEqual({
      id: "rec_1",
      storagePath: null,
    });
    // No object to delete, and the CAS matched nothing — so the row was NOT
    // tombstoned and the audit records a delete that did not happen.
    expect(res).toMatchObject({ success: false, storageDeleted: false });
  });
});

describe("D5 — the policy filter covers all four plan arms", () => {
  it("does not filter a PERMANENT consultation or subscription out of the sweep", async () => {
    mockFindMany.mockResolvedValue([]);
    mockUpdateMany.mockResolvedValue({ count: 0 });

    await RecordingTransferService.processExpiringRecordings(
      14,
      25,
      "PERMANENT",
    );

    const arms =
      mockFindMany.mock.calls[0][0].where.meeting.occurrence.appointment.OR;
    // An OR of single-arm ANDs, never a flat list: an Appointment can carry more
    // than one plan relation, and an AND would demand all of them match.
    expect(arms).toHaveLength(4);
    for (const arm of arms) {
      expect(Object.keys(arm)).toHaveLength(1);
    }
    expect(JSON.stringify(arms)).toContain("recordingStoragePolicy");
  });
});
