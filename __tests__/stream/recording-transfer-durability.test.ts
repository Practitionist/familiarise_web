/**
 * @jest-environment node
 */

/**
 * #1829 — the unowned-object gap: after a successful upload, if the fenced
 * attaching write loses its race the row is retired and names no `storagePath`,
 * so the object just written has no owner at all. Every cleanup mechanism in
 * this repo keys off a row — `collectTombstonePlan` in
 * cleanup-old-stream-recordings retries a failed delete by re-deriving the pair
 * from the row, `deleteRecording` deletes `recording.storagePath`,
 * `reconcile-document-storage` diffs a bucket against `prisma.appointmentDocument`
 * and never looks at `recordings` — so nothing can ever find it again.
 *
 * The code under test made that gap worse by asserting the opposite. The delete
 * ran, `purged.success` went into a log context and was then IGNORED, and the
 * returned error stated as durable fact that the object had been deleted. It
 * also returned `retired: true` regardless, which tells the sweep this is NOT a
 * fault — so a DPDP-relevant orphan was reported as a benign retirement, and the
 * delete was unbounded on top of it.
 *
 * What is pinned here, and what each assertion is for:
 *
 *   1. A failed cleanup never claims a deletion, never reports a benign
 *      retirement, and hands the caller the exact bucket key plus a durable,
 *      attributable system-event breadcrumb.
 *   2. A CONFIRMED delete keeps the existing benign `retired: true` contract —
 *      this is the preservation guard, and it passes both before and after the
 *      fix by design.
 *   3. A database fault after the upload is reported as genuinely uncertain
 *      ownership (`UNCLAIMED`), not as a clean retirement, and does NOT delete:
 *      whether the attaching write landed is unknowable, and deleting on that
 *      uncertainty could destroy a recording a row legitimately owns — possibly
 *      one a replay has already been sold against.
 *   4. A stalled delete is bounded, so one unanswered storage request cannot
 *      hold a batch — or the `transfer-expiring-recordings` cron lock — open.
 *   5. The two callers this agent does not own branch correctly on the new
 *      contract with no edits at all, because `retired` is only true when the
 *      bytes are confirmed gone.
 *
 * The durable object inventory that would let an unowned object be retried
 * without a human is deliberately DEFERRED — it is a schema change. What
 * replaces it here is honest reporting plus a queryable breadcrumb. The
 * DEFERRED WORK note on `recordUnownedObject` specifies what the inventory has
 * to provide.
 */

// Must be set before the service module is loaded: CLEANUP_TIMEOUT_MS reads it
// once, at module scope, exactly like DOWNLOAD_TIMEOUT_MS. Hence the lazy
// `import()` in `beforeAll` below instead of a top-level value import.
//
// Type-only, so it is erased at runtime and cannot drag the module into the
// graph early. It also makes this file a MODULE, which matters: several test
// files in this repo are top-level scripts, and a script's `const` declarations
// land in the global scope and collide with every other script's.
import type * as RecordingTransferServiceModule from "../../lib/stream/recording-transfer-service";

process.env.RECORDING_CLEANUP_TIMEOUT_MS = "60";

const mockUpdateMany = jest.fn();
const mockUpdate = jest.fn();
const mockFindUnique = jest.fn();
const mockFindMany = jest.fn();
const mockCount = jest.fn();
const mockTxUpdateMany = jest.fn();
const mockTxFindUnique = jest.fn();
const mockDeleteRecordingObject = jest.fn();
const mockUpload = jest.fn();

jest.mock("../../lib/prisma", () => {
  // Every reference is an arrow, not a direct capture: `jest.mock` is hoisted
  // above the `const` declarations, so a factory that dereferenced one at
  // module-init time would hit the temporal dead zone.
  const tx = {
    recording: {
      updateMany: (...a: unknown[]) => mockTxUpdateMany(...a),
      findUnique: (...a: unknown[]) => mockTxFindUnique(...a),
    },
  };
  const client = {
    recording: {
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
      update: (...a: unknown[]) => mockUpdate(...a),
      updateMany: (...a: unknown[]) => mockUpdateMany(...a),
      findMany: (...a: unknown[]) => mockFindMany(...a),
      count: (...a: unknown[]) => mockCount(...a),
    },
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

const mockRecordSystemError = jest.fn().mockResolvedValue(undefined);
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: (...a: unknown[]) => mockRecordSystemError(...a),
  recordSystemErrorSafe: (...a: unknown[]) => mockRecordSystemError(...a),
  recordSystemEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../lib/stream/recording-storage", () => ({
  RECORDINGS_BUCKET: "recordings",
  RECORDING_MAX_OBJECT_BYTES: 1024 * 1024,
  RECORDING_MIME_TYPES: ["video/mp4", "application/octet-stream"],
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

jest.mock("../../lib/supabase-storage-core", () => ({
  __esModule: true,
  supabase: { storage: {} },
  supabaseAdmin: { storage: {} },
  ensureBucketExists: jest.fn().mockResolvedValue(true),
}));

jest.mock("../../lib/stream-client", () => ({
  getStreamVideoClient: () => ({
    video: {
      call: () => ({ listRecordings: jest.fn(), deleteRecording: jest.fn() }),
    },
  }),
  withStreamCircuitBreaker: (fn: () => unknown) => fn(),
}));

/** The deterministic key (D2) for the fixture row below. */
const KEY = "recordings/2026/03/rec_1/recording.mp4";

type ServiceModule = typeof RecordingTransferServiceModule;

let service: ServiceModule;

beforeAll(async () => {
  // Deferred so CLEANUP_TIMEOUT_MS sees the env var set at the top of this file.
  service = await import("../../lib/stream/recording-transfer-service");
});

const ROW = {
  id: "rec_1",
  recordingUrl: "https://stream.example/rec_1.mp4",
  recordedAt: new Date("2026-03-04T10:00:00.000Z"),
  storagePath: null,
  organizationId: "org_1",
  transferAttempts: 0,
  transferFailureAlertedAt: null,
};

const bytes = (n: number) => new Uint8Array(n);

const oneChunk = (n: number) =>
  new ReadableStream({
    start(c) {
      c.enqueue(bytes(n));
      c.close();
    },
  });

/** A 200 with a declared 1024-byte mp4 body — the ordinary happy path. */
const okDownload = () => {
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
    body: oneChunk(1024),
  }) as unknown as typeof fetch;
};

beforeEach(() => {
  for (const m of [
    mockUpdateMany,
    mockUpdate,
    mockFindUnique,
    mockFindMany,
    mockCount,
    mockTxUpdateMany,
    mockTxFindUnique,
    mockDeleteRecordingObject,
    mockUpload,
    mockRecordSystemError,
  ]) {
    m.mockReset();
  }
  // Drains the body, as the real client does — a mock that resolved without
  // reading would leave the byte counter at 0.
  mockUpload.mockImplementation(async (_path, body) => {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    return { error: null };
  });
  mockFindUnique.mockResolvedValue(ROW);
  mockTxFindUnique.mockResolvedValue(null);
  mockUpdate.mockResolvedValue({});
  // The failure-revert CAS finds nothing (the row is not ours), so
  // `recordTransferFailure` bails before it reads counters or pages anyone.
  mockTxUpdateMany.mockResolvedValue({ count: 0 });
  mockCount.mockResolvedValue(0);
  mockDeleteRecordingObject.mockResolvedValue({ success: true });
  okDownload();
});

describe("#1829 — the cleanup delete of an unowned object is enforced", () => {
  it("does not claim the object was deleted when the delete FAILED", async () => {
    mockFindUnique.mockResolvedValue(ROW);
    // Claim wins; the attaching write loses — the row was retired mid-flight.
    mockUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    mockDeleteRecordingObject.mockResolvedValue({
      success: false,
      error: "bucket offline",
    });

    const res =
      await service.RecordingTransferService.transferRecordingToSupabase(
        "rec_1",
      );

    // The headline. Before the fix this string asserted, as a durable fact,
    // that the object had been deleted — and `purged.success` had been thrown
    // away a line above, so nothing could contradict it.
    expect(res.success).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.error).not.toMatch(/the copied object was deleted/i);
    expect(res.error).toMatch(/NOT deleted/i);
    // …and it has to be actionable, which means naming the exact key. "Something
    // went wrong" is not something an operator or a future reaper can act on.
    expect(res.error).toContain(KEY);
    // NOT a benign retirement. The whole point is that the object is only
    // harmless once the bytes are gone, and `retired: true` told the sweep this
    // was not a fault.
    expect(res.retired).toBeFalsy();
  });

  it("reports the cleanup disposition and the path so a caller can branch on it", async () => {
    mockUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    mockDeleteRecordingObject.mockResolvedValue({
      success: false,
      error: "bucket offline",
    });

    const res =
      await service.RecordingTransferService.transferRecordingToSupabase(
        "rec_1",
      );

    expect(res.orphanObject).toEqual({
      storagePath: KEY,
      cleanup: "DELETE_FAILED",
      detail: expect.stringContaining("bucket offline"),
    });
    // The delete really was attempted, against the object just uploaded.
    expect(mockDeleteRecordingObject).toHaveBeenCalledWith(KEY);
  });

  it("leaves a durable, attributable breadcrumb that nothing drops on the floor", async () => {
    mockUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    mockDeleteRecordingObject.mockResolvedValue({
      success: false,
      error: "bucket offline",
    });

    await service.RecordingTransferService.transferRecordingToSupabase("rec_1");

    // There is no retry mechanism for an object with no owning row — that is
    // precisely why this exists. What the repo CAN offer is a record that
    // (a) survives the process, (b) names the key, and (c) is enumerable by
    // one indexed query, so the object is actionable by a human instead of
    // merely logged.
    expect(mockRecordSystemError).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "RECORDING_OBJECT_UNOWNED",
        organizationId: "org_1",
        // Same correlation id as the transfer's other events, so one
        // `correlationId` enumerates the whole story of a single recording.
        correlationId: "rec_1",
        context: expect.objectContaining({
          recordingId: "rec_1",
          storagePath: KEY,
          bucket: "recordings",
          cleanup: "DELETE_FAILED",
        }),
      }),
    );
  });

  it("does not write a breadcrumb when the object really is gone", async () => {
    mockUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    mockDeleteRecordingObject.mockResolvedValue({ success: true });

    await service.RecordingTransferService.transferRecordingToSupabase("rec_1");

    // Nothing is owed, so there is nothing to point at. A breadcrumb here would
    // train an operator to ignore the category.
    expect(mockRecordSystemError).not.toHaveBeenCalled();
  });

  it("treats a delete that THREW as a failure, not as a confirmed cleanup", async () => {
    mockUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    // A thrown network error and a `{ success: false }` return are the same fact
    // about the bucket: we asked, and it did not happen.
    mockDeleteRecordingObject.mockRejectedValue(new Error("ECONNRESET"));

    const res =
      await service.RecordingTransferService.transferRecordingToSupabase(
        "rec_1",
      );

    expect(res.orphanObject?.cleanup).toBe("DELETE_FAILED");
    expect(res.error).toMatch(/NOT deleted/i);
    expect(res.retired).toBeFalsy();
  });
});

describe("#1829 — a confirmed deletion keeps the benign retirement contract", () => {
  it("still reports retired: true, because nothing is owed", async () => {
    mockUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    mockDeleteRecordingObject.mockResolvedValue({ success: true });

    const res =
      await service.RecordingTransferService.transferRecordingToSupabase(
        "rec_1",
      );

    // The preservation guard. This is the case the sweep is designed to treat as
    // a non-fault: a concurrent retention tombstone or expiry sweep won the
    // row, the transfer did everything asked of it, and the bytes are gone — so
    // counting it as a failure would make a healthy sweep exit non-zero every
    // time the two crons overlapped.
    expect(res.success).toBe(false);
    expect(res.retired).toBe(true);
    expect(res.orphanObject?.cleanup).toBe("DELETED");
    // And here the deletion claim is TRUE, so it may be made.
    expect(res.error).toMatch(/the copied object was deleted/i);
    expect(mockDeleteRecordingObject).toHaveBeenCalledWith(KEY);
  });
});

describe("#1829 — a database fault after the upload is uncertain, not clean", () => {
  it("reports UNCLAIMED ownership instead of a retirement, and does not delete", async () => {
    mockUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      // The attaching write itself blows up: the upload is committed but the
      // outcome of the write is unknowable — it may have applied and lost its
      // response, or never have run.
      .mockRejectedValueOnce(new Error("connection reset while committing"));

    const res =
      await service.RecordingTransferService.transferRecordingToSupabase(
        "rec_1",
      );

    expect(res.success).toBe(false);
    // A clean "retired" verdict here would be the old lie wearing a new hat: the
    // generic catch knew nothing at all about an object that now exists.
    expect(res.retired).toBeFalsy();
    expect(res.orphanObject).toEqual({
      storagePath: KEY,
      cleanup: "UNCLAIMED",
      detail: expect.stringContaining("connection reset while committing"),
    });
    // The error names the object, so an operator reading the cron log knows a
    // `recordings/…` key may be sitting in the bucket.
    expect(res.error).toContain(KEY);
    expect(res.error).toMatch(/UNCLAIMED/);
    expect(res.error).not.toMatch(/was deleted/i);

    // The load-bearing part. Deleting on that uncertainty is a coin flip that
    // can destroy a recording a row legitimately owns — and a row owns one
    // exactly when it is `AVAILABLE` + `PLATFORM`, which is the pair the
    // publish, purchase and marketplace-listing gates all require. A replay may
    // have been SOLD against those bytes. The deterministic key (D2) is what
    // makes leaving it alone safe: the row reverts to READY, the next attempt
    // writes the SAME key, `upsert` collapses it, and the row ends up owning
    // real bytes.
    expect(mockDeleteRecordingObject).not.toHaveBeenCalled();
  });

  it("still reverts the row to READY so that retry actually happens", async () => {
    mockUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error("connection reset while committing"));

    await service.RecordingTransferService.transferRecordingToSupabase("rec_1");

    const revert = mockTxUpdateMany.mock.calls[0][0];
    expect(revert.data).toMatchObject({
      status: "READY",
      transferAttempts: { increment: 1 },
    });
  });

  it("says nothing about an object when the fault happened BEFORE the upload", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
    }) as unknown as typeof fetch;
    mockUpdateMany.mockResolvedValue({ count: 1 });

    const res =
      await service.RecordingTransferService.transferRecordingToSupabase(
        "rec_1",
      );

    // No bytes were ever written, so there is no object to report and no
    // breadcrumb. Claiming one here would be its own kind of lie.
    expect(res.orphanObject).toBeUndefined();
    expect(mockRecordSystemError).not.toHaveBeenCalled();
  });
});

describe("#1829 — the cleanup delete is bounded", () => {
  it("gives up on a stalled delete instead of holding the batch open", async () => {
    mockUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    // Never settles. Unbounded, this pins the chunk — and the
    // `transfer-expiring-recordings` cron lock — open behind a request with no
    // answer coming, which is how a 6-hourly sweep stops running at all.
    mockDeleteRecordingObject.mockImplementation(() => new Promise(() => {}));

    const startedAt = Date.now();
    const res =
      await service.RecordingTransferService.transferRecordingToSupabase(
        "rec_1",
      );
    const elapsed = Date.now() - startedAt;

    // CLEANUP_TIMEOUT_MS is 60ms here (set at the top of this file). The bound
    // is generous on the assertion so this measures the bound and not the
    // machine.
    expect(elapsed).toBeLessThan(5_000);
    // And "we stopped waiting" is reported as its own disposition, NOT folded
    // into a failure or — worse — into a success. `remove()` takes no signal,
    // so the request was not cancelled and may still complete after we return.
    expect(res.orphanObject?.cleanup).toBe("DELETE_UNCONFIRMED");
    expect(res.orphanObject?.detail).toMatch(/not cancelled|unknown/i);
    expect(res.success).toBe(false);
    expect(res.retired).toBeFalsy();
  });
});

/**
 * The two callers this change does not touch:
 *   - jobs/stream/transfer-expiring-recordings.ts  → `if (result.failed > 0) process.exitCode = 1`
 *   - app/api/cleanup/transfer-expiring-recordings/route.ts → JSON `{ failed, retired, errors }`
 *
 * Both branch on the service's own tally, so the routing below is what makes
 * them correct without an edit. Asserted here so the day someone "simplifies"
 * `retired` back to a constant, this fails rather than silently reintroducing a
 * clean sweep exit over a surviving orphan.
 */
describe("#1829 — the untouched callers route on the new contract", () => {
  beforeEach(() => {
    // One candidate row, so the sweep actually attempts it. `updateMany` is
    // called three times per sweep — the stale-TRANSFERRING reset, then the
    // attempt's claim, then its attaching write — so each queue below is three
    // deep in that order.
    mockFindMany.mockResolvedValue([{ id: "rec_1" }]);
    mockUpdateMany.mockResolvedValueOnce({ count: 0 }); // stale reset
  });

  it("counts a surviving orphan as failed, so the cron exits non-zero", async () => {
    mockUpdateMany
      .mockResolvedValueOnce({ count: 1 }) // claim wins
      .mockResolvedValueOnce({ count: 0 }); // attach lost
    mockDeleteRecordingObject.mockResolvedValue({
      success: false,
      error: "bucket offline",
    });

    const out =
      await service.RecordingTransferService.processExpiringRecordings(14);

    expect(out).toMatchObject({
      processed: 1,
      succeeded: 0,
      failed: 1,
      retired: 0,
    });
    // The job wrapper prints these, and the HTTP twin returns them.
    expect(out.errors.join(" ")).toContain(KEY);
  });

  it("still counts a confirmed cleanup as a benign retirement", async () => {
    mockUpdateMany
      .mockResolvedValueOnce({ count: 1 }) // claim wins
      .mockResolvedValueOnce({ count: 0 }); // attach lost
    mockDeleteRecordingObject.mockResolvedValue({ success: true });

    const out =
      await service.RecordingTransferService.processExpiringRecordings(14);

    expect(out).toMatchObject({
      processed: 1,
      succeeded: 0,
      failed: 0,
      retired: 1,
    });
  });
});
