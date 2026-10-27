/** @jest-environment node */

import { NextRequest } from "next/server";

const mockJobFindFirst = jest.fn();
const mockArtifactFindUnique = jest.fn();
const mockAuditCreate = jest.fn();
const mockRequireOrgAccess = jest.fn();
const mockCreateSignedUrl = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    orgDataExportJob: {
      findFirst: (...args: unknown[]) => mockJobFindFirst(...args),
    },
    orgDataExportArtifact: {
      findUnique: (...args: unknown[]) => mockArtifactFindUnique(...args),
    },
    orgAuditLog: { create: (...args: unknown[]) => mockAuditCreate(...args) },
  },
}));

jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: (...args: unknown[]) => mockRequireOrgAccess(...args),
}));

jest.mock("../../lib/supabase-storage-core", () => ({
  adminStorage: () => ({
    from: () => ({
      createSignedUrl: (...args: unknown[]) => mockCreateSignedUrl(...args),
    }),
  }),
}));

import { GET } from "../../app/api/organizations/[orgId]/data-exports/[exportId]/download/route";

const startedAt = new Date("2026-10-26T00:00:00.000Z");
const expiresAt = new Date(Date.now() + 5 * 60_000);
const readyJob = {
  id: "export-1",
  organizationId: "org-1",
  kind: "PEOPLE",
  status: "READY",
  startedAt,
  expiresAt,
  fileSizeBytes: BigInt(123),
  fileUrl: "https://old-bearer-url.invalid/should-not-be-used",
};
const ownedArtifact = {
  bucket: "org-exports",
  storagePath: "org-1/export-1/1792972800000.json",
  expiresAt,
};

function downloadExport() {
  return GET(
    new NextRequest("https://app.test/api/organizations/org-1/data-exports"),
    { params: Promise.resolve({ orgId: "org-1", exportId: "export-1" }) },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireOrgAccess.mockResolvedValue({
    member: { id: "membership-1", role: "OWNER" },
  });
  mockJobFindFirst.mockResolvedValue(readyJob);
  mockArtifactFindUnique.mockResolvedValue(ownedArtifact);
  mockAuditCreate.mockResolvedValue({});
  mockCreateSignedUrl.mockResolvedValue({
    data: { signedUrl: "https://storage.example/signed" },
    error: null,
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe("data export download route", () => {
  it("creates a fresh short URL from the owned object and disables caching", async () => {
    const response = await downloadExport();

    expect(mockCreateSignedUrl).toHaveBeenCalledWith(
      "org-1/export-1/1792972800000.json",
      expect.any(Number),
    );
    expect(mockCreateSignedUrl.mock.calls[0][1]).toBeLessThanOrEqual(60);
    expect(await response.json()).toMatchObject({
      url: "https://storage.example/signed",
      expiresAt: expiresAt.toISOString(),
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
    expect(mockAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "DATA_EXPORT_DOWNLOAD_REQUESTED",
      }),
    });
  });

  it("never serves the legacy bearer URL when the attempt owner is missing", async () => {
    mockArtifactFindUnique.mockResolvedValue(null);

    const response = await downloadExport();

    expect(response.status).toBe(410);
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      code: "EXPORT_UNAVAILABLE",
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("calculates the signing lifetime after the artifact lookup", async () => {
    const now = Date.parse("2026-10-26T12:00:00Z");
    jest.useFakeTimers({ now });
    const expiry = new Date(now + 75_000);
    mockJobFindFirst.mockResolvedValueOnce({ ...readyJob, expiresAt: expiry });
    mockArtifactFindUnique.mockImplementationOnce(async () => {
      jest.advanceTimersByTime(45_000);
      return { ...ownedArtifact, expiresAt: expiry };
    });

    const response = await downloadExport();

    expect(response.status).toBe(200);
    expect(mockCreateSignedUrl).toHaveBeenCalledWith(
      ownedArtifact.storagePath,
      30,
    );
  });

  it.each(["signing", "audit"])(
    "refuses the URL when the artifact expires during %s",
    async (slowStep) => {
      const now = Date.parse("2026-10-26T12:00:00Z");
      jest.useFakeTimers({ now });
      const expiry = new Date(now + 1_500);
      mockJobFindFirst.mockResolvedValueOnce({
        ...readyJob,
        expiresAt: expiry,
      });
      mockArtifactFindUnique.mockResolvedValueOnce({
        ...ownedArtifact,
        expiresAt: expiry,
      });
      if (slowStep === "signing") {
        mockCreateSignedUrl.mockImplementationOnce(async () => {
          jest.advanceTimersByTime(2_000);
          return {
            data: { signedUrl: "https://storage.example/signed" },
            error: null,
          };
        });
      } else {
        mockAuditCreate.mockImplementationOnce(async () => {
          jest.advanceTimersByTime(2_000);
          return {};
        });
      }

      const response = await downloadExport();

      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({
        code: "EXPORT_EXPIRED",
        error: "Export bundle has expired; request a fresh one",
      });
      expect(mockAuditCreate).toHaveBeenCalledTimes(
        slowStep === "signing" ? 0 : 1,
      );
    },
  );
});
