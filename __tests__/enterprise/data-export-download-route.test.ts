/** @jest-environment node */

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

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireOrgAccess.mockResolvedValue({
    member: { id: "membership-1", role: "OWNER" },
  });
  mockJobFindFirst.mockResolvedValue({
    id: "export-1",
    organizationId: "org-1",
    kind: "PEOPLE",
    status: "READY",
    startedAt,
    expiresAt,
    fileSizeBytes: 123n,
    fileUrl: "https://old-bearer-url.invalid/should-not-be-used",
  });
  mockArtifactFindUnique.mockResolvedValue({
    bucket: "org-exports",
    storagePath: "org-1/export-1/1792972800000.json",
    expiresAt,
  });
  mockAuditCreate.mockResolvedValue({});
  mockCreateSignedUrl.mockResolvedValue({
    data: { signedUrl: "https://storage.example/signed" },
    error: null,
  });
});

describe("data export download route", () => {
  it("creates a fresh short URL from the owned object and disables caching", async () => {
    const response = await GET({} as never, {
      params: Promise.resolve({ orgId: "org-1", exportId: "export-1" }),
    });

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
  });

  it("never serves the legacy bearer URL when the attempt owner is missing", async () => {
    mockArtifactFindUnique.mockResolvedValue(null);

    const response = await GET({} as never, {
      params: Promise.resolve({ orgId: "org-1", exportId: "export-1" }),
    });

    expect(response.status).toBe(410);
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      code: "EXPORT_UNAVAILABLE",
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
