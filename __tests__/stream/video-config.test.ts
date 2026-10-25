/**
 * @jest-environment node
 */

const mockFindUnique = jest.fn();
const mockAuth = jest.fn();
const mockOpsCreate = jest.fn();
const mockUpsert = jest.fn();

jest.mock("../../lib/prisma", () => {
  const tx = {
    platformVideoConfig: {
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
      upsert: (...a: unknown[]) => mockUpsert(...a),
    },
    opsActionLog: { create: (...a: unknown[]) => mockOpsCreate(...a) },
  };
  return {
    __esModule: true,
    default: {
      ...tx,
      $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    },
  };
});

jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: (...a: unknown[]) => mockAuth(...a),
}));

jest.mock("../../lib/auth/step-up", () => ({ requireFreshSession: jest.fn() }));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/api/after-safe", () => ({ scheduleAfter: jest.fn() }));

import { NextRequest, NextResponse } from "next/server";
import { getPlatformVideoConfig } from "../../lib/stream/video-config";
import { DEFAULT_VIDEO_CONFIG } from "../../lib/stream/video-quality";
import { hasBackofficePermission } from "../../lib/auth/backoffice-permissions";
import { GET, PATCH } from "../../app/api/admin/video-config/route";

const session = { user: { id: "staff-1", role: "STAFF" } };
const patch = (body: unknown) =>
  PATCH(
    new NextRequest("http://localhost/api/admin/video-config", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({ session });
  mockFindUnique.mockResolvedValue(null);
  mockOpsCreate.mockResolvedValue({ id: "ops-1" });
  mockUpsert.mockResolvedValue({});
});

describe("getPlatformVideoConfig", () => {
  it("falls back to the defaults when the config cannot be read", async () => {
    mockFindUnique.mockRejectedValueOnce(new Error("relation does not exist"));
    await expect(getPlatformVideoConfig()).resolves.toEqual(
      DEFAULT_VIDEO_CONFIG,
    );
  });

  it("reads the defaults when no row exists", async () => {
    await expect(getPlatformVideoConfig()).resolves.toEqual(
      DEFAULT_VIDEO_CONFIG,
    );
    expect(DEFAULT_VIDEO_CONFIG).toEqual({
      callTargetResolution: "720p",
      recordingQuality: "720p",
      screenshareTargetResolution: "1080p",
    });
  });

  it("reads a stored row and falls back per field on a value it no longer knows", async () => {
    mockFindUnique.mockResolvedValue({
      callTargetResolution: "1080p",
      recordingQuality: "4k",
      screenshareTargetResolution: "720p",
    });
    await expect(getPlatformVideoConfig()).resolves.toEqual({
      callTargetResolution: "1080p",
      recordingQuality: "720p",
      screenshareTargetResolution: "720p",
    });
  });
});

describe("/api/admin/video-config", () => {
  it("lets STAFF and ADMIN manage the surface", () => {
    expect(hasBackofficePermission("STAFF", "videoConfig.manage")).toBe(true);
    expect(hasBackofficePermission("ADMIN", "videoConfig.manage")).toBe(true);
    expect(hasBackofficePermission("CONSULTANT", "videoConfig.manage")).toBe(
      false,
    );
  });

  it("refuses a caller without the surface", async () => {
    mockAuth.mockResolvedValue({
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });
    expect((await GET()).status).toBe(403);
    expect(
      (await patch({ recordingQuality: "1080p", reason: "cost review" }))
        .status,
    ).toBe(403);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it.each([
    [{ recordingQuality: "1440p", reason: "cost review" }],
    [{ callTargetResolution: "4k", reason: "cost review" }],
    [{ recordingQuality: "1080p" }],
    [{ recordingQuality: "1080p", reason: "ok" }],
  ])("rejects the invalid body %j", async (body) => {
    expect((await patch(body)).status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("refuses an empty change", async () => {
    expect((await patch({ reason: "nothing to do" })).status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("saves the change and writes the audit row with before and after", async () => {
    mockFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      callTargetResolution: "720p",
      recordingQuality: "1080p",
      screenshareTargetResolution: "1080p",
    });
    const res = await patch({
      recordingQuality: "1080p",
      reason: "customers asked for sharper replays",
    });
    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          recordingQuality: "1080p",
          callTargetResolution: "720p",
          updatedById: "staff-1",
        }),
        update: expect.objectContaining({ recordingQuality: "1080p" }),
      }),
    );
    expect(mockOpsCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: "staff-1",
        surface: "videoConfig.manage",
        action: "videoConfig.update",
        targetKind: "PlatformVideoConfig",
        targetId: "singleton",
        reason: "customers asked for sharper replays",
        before: DEFAULT_VIDEO_CONFIG,
        after: expect.objectContaining({ recordingQuality: "1080p" }),
      }),
      select: { id: true },
    });
  });
});
