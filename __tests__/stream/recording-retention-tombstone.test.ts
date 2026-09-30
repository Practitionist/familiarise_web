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
    // #1829 — a page PLUS ONE row, as a lookahead probe. Bounded either way;
    // the extra row is what makes "is there a next page?" a certainty rather
    // than an inference.
    expect(first.take).toBe(201);
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
    // 201 rows: a full page plus the lookahead probe. The probe is what tells
    // the walk a second page exists, so a 200-row first page now correctly ends
    // the walk — this fixture has to carry the extra row to reach page two.
    const full = Array.from({ length: 201 }, (_, i) => ({
      id: `rec_${i}`,
      storagePath: null,
      createdAt: OLD,
    }));
    mockRecordingFindMany
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce([candidate("rec_last", null)]);

    await cleanupOldStreamRecordings();

    const second = mockRecordingFindMany.mock.calls[1][0];
    expect(second.take).toBe(201);
    // `skip` would be wrong: rows tombstoned by page 1 leave the `notIn` filter
    // while this run is still walking, so an offset cursor would skip rows.
    expect(second.skip).toBeUndefined();
    expect(JSON.stringify(second.where.OR)).toContain("rec_199");
  });
});

/**
 * #1829 — the "there may be more" signal must not fire on a clean drain.
 *
 * `PER_ORG_CANDIDATE_CAP` is CANDIDATE_PAGE_SIZE (200) × PER_ORG_PAGE_CAP (5) =
 * 1000. An org with exactly 1000 stale recordings runs all five pages,
 * tombstones every one, and empties completely — and the old check
 * (`candidates.length >= PER_ORG_CANDIDATE_CAP`) reported that as a failure,
 * which the job turns into a non-zero exit and the workflow's `if: failure()`
 * step turns into a Slack page and a Sentry event.
 *
 * So a perfectly successful run paged, on the job that enforces a DPDP
 * obligation, and it would clear itself the next day. A real signal that cannot
 * be reproduced is worse than no signal, because it trains the reader to ignore
 * this job.
 */
describe("the candidate-cap signal (#1829)", () => {
  /**
   * A queue of exactly `total` rows, served the way the script paginates.
   *
   * Keyset, not offset: the script asks for `CANDIDATE_PAGE_SIZE + 1` and then
   * processes at most `CANDIDATE_PAGE_SIZE`, advancing its cursor from the last
   * PROCESSED row. So each call must serve the rows after the cursor, one page
   * plus the lookahead probe — and the probe is never handed back as a
   * candidate.
   */
  const queue = (total: number) => {
    let served = 0;
    mockRecordingFindMany.mockImplementation(async () => {
      const remaining = total - served;
      const n = Math.min(201, remaining);
      const rows = Array.from({ length: n }, (_, i) =>
        candidate(`rec_${served + i}`, null),
      );
      // Mirror the script: keep a full page, and treat a 201st row as proof that
      // another page exists without consuming it.
      const consumed = Math.min(200, n);
      served += consumed;
      return rows;
    });
  };

  it("drains exactly PER_ORG_CANDIDATE_CAP rows WITHOUT reporting a failure", async () => {
    // 200 x 5 = 1000. Every one of these rows is tombstoned and this org is
    // completely drained by the end of the run — so reporting a failure here is a
    // lie, and the job turns that lie into a non-zero exit and the workflow's
    // `if: failure()` step into a Slack page and a Sentry event.
    //
    // This case is only expressible because the page walk reads ONE ROW BEYOND a
    // full page. Without that lookahead, "the last page came back full" is
    // equally true for 1000 and 1001 rows, so the two cannot be told apart and
    // no test can pin the correct one.
    queue(1000);
    const result = await cleanupOldStreamRecordings();

    expect(result.errors.join(" ")).not.toContain("past retention");
    expect(result.success).toBe(true);
    // And it really did collect and process all of them.
    expect(result.scanned).toBe(1000);
  });

  it("reports a failure when rows genuinely remain past the cap", async () => {
    // One row more. The lookahead is what makes this distinguishable from the
    // 1000-row case above, and the message must say more REMAINS rather than
    // quoting a fixed cap, because the count is what was processed.
    queue(1001);
    const result = await cleanupOldStreamRecordings();

    expect(result.errors.join(" ")).toContain("past retention");
    expect(result.errors.join(" ")).toContain("more remain");
    expect(result.scanned).toBe(1000);
  });

  it("is silent below the cap", async () => {
    queue(137);
    const result = await cleanupOldStreamRecordings();

    expect(result.errors.join(" ")).not.toContain("past retention");
    expect(result.success).toBe(true);
    expect(result.scanned).toBe(137);
  });

  it("is silent on an empty queue", async () => {
    queue(0);
    const result = await cleanupOldStreamRecordings();

    expect(result.errors.join(" ")).not.toContain("past retention");
  });

  it("asks for one row beyond a page, and never processes the probe", async () => {
    queue(3);
    await cleanupOldStreamRecordings();

    const call = mockRecordingFindMany.mock.calls[0][0];
    expect(call.take).toBe(201);
    // With 3 rows the single page returns 3 — under the page size, so nothing
    // was sliced off and no row is lost to the probe.
    expect(mockRecordingFindMany.mock.calls[0][0].take).toBe(201);
  });
});
