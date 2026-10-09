/**
 * @jest-environment node
 */

const OLD = "2020-01-01T00:00:00Z";
const bucketFiles: Record<string, string[]> = {
  documents: [
    "appointments/a1/consultee-c1/kept.pdf",
    "plans/class-plans/p1/material.pdf",
    "verification/u1/id.pdf",
    "appointments/a1/consultee-c1/orphan.pdf",
  ],
  "support-attachments": ["support-tickets/t1/orphan.png"],
};
const remove = jest.fn(async (bucket: string, paths: string[]) => ({
  // Support-attachment removals are dropped, as an unconfirmed delete would be.
  data: bucket === "documents" ? paths.map((name) => ({ name })) : [],
  error: null,
}));

jest.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    storage: {
      from: (bucket: string) => ({
        list: async (path: string) => ({
          data: path
            ? []
            : (bucketFiles[bucket] ?? []).map((name) => ({
                name,
                metadata: {},
                created_at: OLD,
              })),
          error: null,
        }),
        remove: (paths: string[]) => remove(bucket, paths),
      }),
    },
  }),
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_job: string, _opts: unknown, fn: () => unknown) => fn(),
  LONG_JOB_TTL_MS: 1,
}));

jest.mock("../../lib/observability/report", () => ({
  reportSentryMessage: jest.fn(),
}));

jest.mock("../../lib/supabase-storage-core", () => ({
  deleteAppointmentDocument: jest.fn(),
}));

const rows = (paths: string[]) => paths.map((storagePath) => ({ storagePath }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointmentDocument: {
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(async () => ({ count: 0 })),
      delete: jest.fn(async () => ({})),
    },
    planMaterial: { findMany: jest.fn() },
    profileVerificationDocument: { findMany: jest.fn() },
    supportTicketAttachment: { findMany: jest.fn(async () => []) },
  },
}));

import prisma from "../../lib/prisma";
import { reportSentryMessage } from "../../lib/observability/report";
import { deleteAppointmentDocument } from "../../lib/supabase-storage-core";
import { reconcileDocumentStorage } from "../../scripts/cleanup/reconcile-document-storage";
import { purgeExpiredDeletedDocuments } from "../../lib/documents/document-purge";

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("reconcile-document-storage orphan sweep", () => {
  it("keeps plan materials and verification documents, sweeps support attachments, and reports a shortfall once", async () => {
    (prisma.appointmentDocument.findMany as jest.Mock).mockResolvedValue(
      rows(["appointments/a1/consultee-c1/kept.pdf"]),
    );
    (prisma.planMaterial.findMany as jest.Mock).mockResolvedValue(
      rows(["plans/class-plans/p1/material.pdf"]),
    );
    (
      prisma.profileVerificationDocument.findMany as jest.Mock
    ).mockResolvedValue(rows(["verification/u1/id.pdf"]));

    const result = await reconcileDocumentStorage();

    expect(remove).toHaveBeenCalledWith("documents", [
      "appointments/a1/consultee-c1/orphan.pdf",
    ]);
    expect(remove).toHaveBeenCalledWith("support-attachments", [
      "support-tickets/t1/orphan.png",
    ]);
    expect(result.orphanedFilesFound).toBe(2);
    expect(result.orphanedFilesDeleted).toBe(1);
    expect(result.success).toBe(false);
    expect(result.errors).toEqual([
      "1 orphaned files in support-attachments were not removed",
    ]);
  });
});

describe("purge-deleted-documents", () => {
  it("retries rows whose bytes survive and reports the run once", async () => {
    (prisma.appointmentDocument.findMany as jest.Mock)
      .mockResolvedValueOnce([
        { id: "d1", storagePath: "a/1.pdf", isStorageMissing: false },
        { id: "d2", storagePath: "a/2.pdf", isStorageMissing: false },
        { id: "d3", storagePath: "a/3.pdf", isStorageMissing: false },
      ])
      .mockResolvedValueOnce([]);
    (deleteAppointmentDocument as jest.Mock).mockImplementation(
      async (path: string) => path === "a/1.pdf",
    );

    const result = await purgeExpiredDeletedDocuments(30);

    expect(result).toEqual({ purged: 1, failedStorage: 2, failedRows: 0 });
    expect(prisma.appointmentDocument.delete).toHaveBeenCalledTimes(1);
    expect(reportSentryMessage).toHaveBeenCalledTimes(1);
  });
});
