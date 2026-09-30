/**
 * @jest-environment node
 */

/**
 * #1829 — the operator DELETE must not remove bytes a buyer has paid for.
 *
 * `deleteRecording` tombstones the row (EXPIRED, `storagePath` null) and deletes
 * the object from the bucket. Nothing there touches `RecordingPurchase`, and the
 * relation is `onDelete: Cascade` — but the Recording row is never deleted, only
 * tombstoned, so that cascade never fires. The purchase therefore outlives the
 * recording it pays for.
 *
 * The result is silent in both directions. `RecordingPurchase.status` still reads
 * SUCCEEDED, so the buyer's entitlement check still passes; the Recording row
 * still exists, so nothing 404s at the database level. The only symptom is a
 * support ticket saying the paid recording will not play, and no record anywhere
 * that money was taken for it.
 *
 * 409 rather than an automatic refund, because refunding is a money movement and
 * belongs to the refund front door. The operator refunds, then the delete
 * succeeds because the purchase is no longer SUCCEEDED.
 */

const mockPurchaseFindFirst = jest.fn();
const mockRecordingFindUnique = jest.fn();
const mockRecordingUpdateMany = jest.fn();
const mockDeleteRecording = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    recordingPurchase: {
      findFirst: (...a: unknown[]) => mockPurchaseFindFirst(...a),
    },
    recording: {
      findUnique: (...a: unknown[]) => mockRecordingFindUnique(...a),
    },
    orgAuditLog: { create: jest.fn() },
    systemEvent: { create: jest.fn() },
    $transaction: (fn: (t: unknown) => unknown) => Promise.resolve(fn({})),
    $disconnect: jest.fn(),
  },
}));

jest.mock("../../lib/stream/recording-transfer-service", () => ({
  RecordingTransferService: {
    deleteRecording: (...a: unknown[]) => mockDeleteRecording(...a),
  },
}));

jest.mock("../../lib/stream/recording-storage", () => ({
  getBestRecordingUrl: jest.fn(),
  deleteRecordingObject: jest.fn(),
}));

jest.mock("../../lib/auth-server", () => ({
  getSession: jest.fn(),
}));

jest.mock("../../lib/stream/recording-operator-access", () => ({
  auditOperatorRecordingAccess: jest.fn(),
  resolveOperatorRecordingAccess: jest.fn(() => ({ canPlay: true })),
}));

import { getSession } from "../../lib/auth-server";
import { DELETE } from "../../app/api/stream/recordings/[recordingId]/route";

const mockGetSession = getSession as jest.MockedFunction<typeof getSession>;

const REQ = {} as never;
const params = Promise.resolve({ recordingId: "rec_1" });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({
    user: { id: "admin_1", role: "ADMIN" },
  } as never);
  mockPurchaseFindFirst.mockResolvedValue(null);
  mockRecordingFindUnique.mockResolvedValue({
    id: "rec_1",
    title: "Session",
    storagePath: "recordings/2026/03/rec_1/recording.mp4",
    streamCallId: null,
    organizationId: "org_1",
    meeting: { id: "m_1" },
  });
  mockRecordingUpdateMany.mockResolvedValue({ count: 1 });
  mockDeleteRecording.mockResolvedValue({
    success: true,
    storageDeleted: true,
    streamDeleted: false,
  });
});

describe("DELETE /api/stream/recordings/[recordingId] — paid recordings (#1829)", () => {
  it("refuses with 409 while a SUCCEEDED purchase exists, deleting nothing", async () => {
    mockPurchaseFindFirst.mockResolvedValue({
      id: "rp_1",
      buyerId: "buyer_1",
    });

    const res = await DELETE(REQ, { params } as never);
    const body = await res.json();

    expect(res.status).toBe(409);
    // The guard fires BEFORE the transfer service, so no object is deleted and
    // no row is tombstoned. A 409 that had already deleted the bytes would be
    // worse than no guard at all.
    expect(mockDeleteRecording).not.toHaveBeenCalled();
    expect(mockRecordingUpdateMany).not.toHaveBeenCalled();
    expect(body.purchaseId).toBe("rp_1");
    // And the query is narrow: one succeeded purchase for THIS recording.
    expect(mockPurchaseFindFirst).toHaveBeenCalledWith({
      where: { recordingId: "rec_1", status: "SUCCEEDED" },
      select: { id: true, buyerId: true },
    });
  });

  it("deletes normally once the purchase is no longer SUCCEEDED", async () => {
    // The intended operator flow: refund first (the purchase leaves SUCCEEDED),
    // then delete. The refund is a separate, idempotent front door.
    mockPurchaseFindFirst.mockResolvedValue(null);

    const res = await DELETE(REQ, { params } as never);

    expect(res.status).toBe(200);
    expect(mockDeleteRecording).toHaveBeenCalledWith("rec_1");
    expect(await res.json()).toMatchObject({ success: true });
  });

  it("surfaces a lost tombstone CAS as a 500, not a success", async () => {
    // The service refuses when its fenced updateMany matches nothing, so a row
    // that changed under us must not be reported to the operator as deleted.
    mockDeleteRecording.mockResolvedValue({
      success: false,
      error: "Recording changed during deletion — nothing was tombstoned.",
      storageDeleted: true,
      streamDeleted: false,
    });

    const res = await DELETE(REQ, { params } as never);

    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.success).toBeUndefined();
    expect(body.error).toContain("nothing was tombstoned");
  });
});
