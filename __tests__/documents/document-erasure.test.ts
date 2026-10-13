/**
 * @jest-environment node
 */

jest.mock("../../lib/supabase-storage-core", () => ({
  deleteAppointmentDocument: jest.fn(),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_job: string, _opts: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { reportSentryError } from "../../lib/observability/report";
import { deleteAppointmentDocument } from "../../lib/supabase-storage-core";
import { eraseUserSessionDocuments } from "../../lib/documents/document-erasure";

const db = {
  appointmentDocument: {
    updateMany: jest.fn(),
    findMany: jest.fn(),
    deleteMany: jest.fn(),
  },
};

describe("erasure covers session documents", () => {
  it("tombstones the user's threads, deletes their files at once and reports a failure once", async () => {
    db.appointmentDocument.updateMany.mockResolvedValue({ count: 2 });
    db.appointmentDocument.deleteMany.mockResolvedValue({ count: 1 });
    db.appointmentDocument.findMany
      .mockResolvedValueOnce([
        {
          id: "v2",
          storagePath: "a/2.pdf",
          isStorageMissing: false,
          removalReason: "ACCOUNT_ERASURE",
        },
        {
          id: "r1",
          storagePath: "a/1.pdf",
          isStorageMissing: false,
          removalReason: "ACCOUNT_ERASURE",
        },
      ])
      .mockResolvedValueOnce([]);
    (deleteAppointmentDocument as jest.Mock).mockImplementation(
      async (path: string) => path === "a/2.pdf",
    );

    const failures = await eraseUserSessionDocuments(db as never, "u1");

    const tombstone = db.appointmentDocument.updateMany.mock.calls[0][0];
    expect(tombstone.data).toMatchObject({ removalReason: "ACCOUNT_ERASURE" });
    expect(tombstone.where.OR).toContainEqual(
      expect.objectContaining({ uploadedByRole: "CONSULTANT" }),
    );
    const purgeScope = db.appointmentDocument.findMany.mock.calls[0][0].where;
    expect(purgeScope.AND[0]).not.toHaveProperty("removalReason");
    expect(db.appointmentDocument.deleteMany).toHaveBeenCalledTimes(1);
    expect(failures).toHaveLength(1);
    expect(reportSentryError).toHaveBeenCalledTimes(1);
  });
});
