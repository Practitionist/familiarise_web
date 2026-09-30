/**
 * @jest-environment node
 */

/**
 * D1 (third writer) — the retention tombstone was unfenced, and it had the worst
 * outcome of the three.
 *
 * `cleanup-old-stream-recordings` reads its candidate list BEFORE deleting any
 * storage objects, so the gap between "this row was scanned" and "this row is
 * flipped to EXPIRED" is the whole delete loop — seconds to minutes, inside a
 * 10-minute workflow budget. Its `updateMany` was `where: { id: { in: ids } }`,
 * which excludes nothing. Two things went wrong in that window:
 *
 *   (a) A row with a null `storagePath` was tombstoned while a transfer was in
 *       flight. The transfer then completed and wrote `storagePath` + `PLATFORM`
 *       + `AVAILABLE` — resurrecting a row past its retention window, pointing at
 *       bytes this sweep had never deleted (it only ever deletes the object named
 *       by `storagePath`). Those bytes then outlived the org's window, which is a
 *       DPDP violation, and the row became permanently invisible to this sweep's
 *       own `status: { notIn: ["EXPIRED", "FAILED"] }` candidate filter, so
 *       nothing would ever reclaim it.
 *
 *   (b) A row whose transfer COMPLETED between the scan and the flip was still
 *       `notIn [EXPIRED, FAILED]`, so it was tombstoned — with an object in the
 *       bucket that nothing would delete, because this run had already decided
 *       from the stale null path that there was nothing to delete.
 *
 * The fix fences each flip on exactly what the run observed: the no-object group
 * on `storagePath: null`, the had-object group on the specific path whose object
 * was just deleted, and counts only flips that actually landed.
 */

const mockOrgFindMany = jest.fn();
const mockRecordingFindMany = jest.fn();
const mockRecordingUpdateMany = jest.fn();
const mockOrgAuditLogCreate = jest.fn();
const mockDeleteRecordingObject = jest.fn();

jest.mock("../../lib/prisma", () => {
  const tx = {
    recording: {
      updateMany: (...a: unknown[]) => mockRecordingUpdateMany(...a),
    },
    orgAuditLog: { create: (...a: unknown[]) => mockOrgAuditLogCreate(...a) },
  };
  return {
    __esModule: true,
    default: {
      organization: {
        findMany: (...a: unknown[]) => mockOrgFindMany(...a),
      },
      recording: {
        findMany: (...a: unknown[]) => mockRecordingFindMany(...a),
      },
      $transaction: (fn: (t: typeof tx) => unknown) => Promise.resolve(fn(tx)),
      $disconnect: jest.fn(),
    },
  };
});
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_n: string, _o: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../../lib/stream/recording-storage", () => ({
  deleteRecordingObject: (...a: unknown[]) => mockDeleteRecordingObject(...a),
}));

import { cleanupOldStreamRecordings } from "../../scripts/cleanup/cleanup-old-stream-recordings";

const OLD = new Date("2020-01-01T00:00:00.000Z");

beforeEach(() => {
  for (const m of [
    mockOrgFindMany,
    mockRecordingFindMany,
    mockRecordingUpdateMany,
    mockOrgAuditLogCreate,
    mockDeleteRecordingObject,
  ]) {
    m.mockReset();
  }
  mockOrgFindMany.mockResolvedValue([
    { id: "org_1", streamRecordingRetentionDays: 90 },
  ]);
  // One short page, so the keyset loop exits after a single query.
  mockRecordingFindMany.mockResolvedValue([]);
  mockRecordingUpdateMany.mockResolvedValue({ count: 1 });
  mockOrgAuditLogCreate.mockResolvedValue({});
  mockDeleteRecordingObject.mockResolvedValue({ success: true });
});

/** One candidate row, as the paged query returns it. */
const candidate = (id: string, storagePath: string | null) => ({
  id,
  storagePath,
  createdAt: OLD,
});

describe("retention tombstone fencing", () => {
  it("fences the no-object group on storagePath still being null", async () => {
    mockRecordingFindMany.mockResolvedValueOnce([candidate("rec_1", null)]);

    await cleanupOldStreamRecordings();

    const where = mockRecordingUpdateMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ id: "rec_1", storagePath: null }]);
    // The candidate filter is repeated on the flip so a row that became FAILED
    // between scan and flip is not rewritten as EXPIRED.
    expect(where.status).toEqual({ notIn: ["EXPIRED", "FAILED"] });
  });

  it("fences the had-object group on the exact path whose object it deleted", async () => {
    mockRecordingFindMany.mockResolvedValueOnce([
      candidate("rec_1", "recordings/2020/01/rec_1/recording.mp4"),
    ]);

    await cleanupOldStreamRecordings();

    // The object goes first — a flip that outran its delete would leave an
    // EXPIRED row pointing at bytes still in the bucket.
    expect(mockDeleteRecordingObject).toHaveBeenCalledWith(
      "recordings/2020/01/rec_1/recording.mp4",
    );
    expect(mockRecordingUpdateMany.mock.calls[0][0].where.OR).toEqual([
      {
        id: "rec_1",
        storagePath: "recordings/2020/01/rec_1/recording.mp4",
      },
    ]);
  });

  it("keeps the object deletion out of the no-object group", async () => {
    mockRecordingFindMany.mockResolvedValueOnce([candidate("rec_1", null)]);

    await cleanupOldStreamRecordings();

    expect(mockDeleteRecordingObject).not.toHaveBeenCalled();
  });

  it("leaves a row alone when the storage delete failed", async () => {
    mockRecordingFindMany.mockResolvedValueOnce([
      candidate("rec_1", "recordings/2020/01/rec_1/recording.mp4"),
    ]);
    mockDeleteRecordingObject.mockResolvedValue({
      success: false,
      error: "bucket offline",
    });

    const res = await cleanupOldStreamRecordings();

    // Tombstoning a row whose bytes are still in the bucket is the orphan this
    // sweep exists to prevent, so the row stays put for tomorrow's retry.
    expect(mockRecordingUpdateMany).not.toHaveBeenCalled();
    expect(res.success).toBe(false);
  });

  it("counts only flips that landed, so the audit never claims work it did not do", async () => {
    mockRecordingFindMany.mockResolvedValueOnce([
      candidate("rec_1", null),
      candidate("rec_2", null),
    ]);
    // Both candidates lost their race to a completing transfer.
    mockRecordingUpdateMany.mockResolvedValue({ count: 0 });

    const res = await cleanupOldStreamRecordings();

    expect(res.expired).toBe(0);
    expect(mockOrgAuditLogCreate).not.toHaveBeenCalled();
  });

  it("reports the real count, not the candidate count", async () => {
    mockRecordingFindMany.mockResolvedValueOnce([
      candidate("rec_1", null),
      candidate("rec_2", null),
    ]);
    mockRecordingUpdateMany.mockResolvedValue({ count: 1 });

    const res = await cleanupOldStreamRecordings();

    expect(res.expired).toBe(1);
    expect(mockOrgAuditLogCreate.mock.calls[0][0].data.details).toMatchObject({
      count: 1,
    });
  });
});

describe("D7 — the candidate query is bounded and paged", () => {
  it("pages with a take and a keyset cursor, not an unbounded scan", async () => {
    mockRecordingFindMany.mockResolvedValue([]);

    await cleanupOldStreamRecordings();

    const first = mockRecordingFindMany.mock.calls[0][0];
    expect(first.take).toBe(200);
    // A `select`, not the whole row.
    expect(first.select).toEqual({
      id: true,
      storagePath: true,
      createdAt: true,
    });
    // Deterministic order for the cursor.
    expect(first.orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
  });

  it("stops after the first short page", async () => {
    mockRecordingFindMany.mockResolvedValueOnce([
      { id: "rec_1", storagePath: null, createdAt: OLD },
    ]);

    await cleanupOldStreamRecordings();

    // One row is a short page: a second query would be pure cost.
    expect(mockRecordingFindMany).toHaveBeenCalledTimes(1);
  });

  it("walks the next page with a keyset cursor rather than a skip offset", async () => {
    const full = Array.from({ length: 200 }, (_, i) => ({
      id: `rec_${i}`,
      storagePath: null,
      createdAt: OLD,
    }));
    mockRecordingFindMany
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce([candidate("rec_last", null)]);

    await cleanupOldStreamRecordings();

    const second = mockRecordingFindMany.mock.calls[1][0];
    expect(second.take).toBe(200);
    // `skip` would be wrong: rows tombstoned by page 1 leave the `notIn` filter
    // while this run is still walking, so an offset cursor would skip rows.
    expect(second.skip).toBeUndefined();
    expect(JSON.stringify(second.where.OR)).toContain("rec_199");
  });
});
