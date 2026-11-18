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
const listFailures = new Set<string>();
const remove = jest.fn(async (bucket: string, paths: string[]) => ({
  // Support-attachment removals are dropped, as an unconfirmed delete would be.
  data: bucket === "documents" ? paths.map((name) => ({ name })) : [],
  error: null,
}));

jest.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    storage: {
      from: (bucket: string) => ({
        list: async (path: string) =>
          listFailures.has(`${bucket}/${path}`)
            ? { data: null, error: new Error("listing failed") }
            : {
                data: path
                  ? []
                  : (bucketFiles[bucket] ?? []).map((name) => ({
                      name,
                      metadata: {},
                      created_at: OLD,
                    })),
                error: null,
              },
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
jest.mock("../../lib/prisma", () => {
  const client = {
    $executeRaw: jest.fn(async () => 1),
    $transaction: jest.fn(),
    appointment: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => null),
    },
    appointmentDocument: {
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      updateMany: jest.fn(async () => ({ count: 0 })),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    planMaterial: { findMany: jest.fn() },
    profileVerificationDocument: { findMany: jest.fn() },
    supportCaseAttachment: { findMany: jest.fn(async () => []) },
  };
  client.$transaction.mockImplementation(
    async (fn: (tx: typeof client) => Promise<unknown>) => fn(client),
  );
  return { __esModule: true, default: client };
});

import prisma from "../../lib/prisma";
import { reportSentryMessage } from "../../lib/observability/report";
import { deleteAppointmentDocument } from "../../lib/supabase-storage-core";
import { reconcileDocumentStorage } from "../../scripts/cleanup/reconcile-document-storage";
import { purgeDeletedDocuments } from "../../lib/documents/document-purge";

beforeEach(() => {
  jest.clearAllMocks();
  listFailures.clear();
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

describe("reconcile-document-storage support attachment references", () => {
  it("lets a deleted attachment row's object be swept as an orphan", async () => {
    await reconcileDocumentStorage();

    const where = (prisma.supportCaseAttachment.findMany as jest.Mock).mock
      .calls[0][0].where;
    expect(where.OR).toContainEqual({
      completedAt: { not: null },
      deletedAt: null,
    });
    expect(where.OR).not.toContainEqual({ completedAt: { not: null } });
  });
});

describe("reconcile-document-storage listing failure", () => {
  it("aborts without deleting or flagging anything when a bucket listing fails", async () => {
    listFailures.add("support-attachments/");

    const result = await reconcileDocumentStorage();

    expect(remove).not.toHaveBeenCalled();
    expect(prisma.appointmentDocument.updateMany).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
  });
});

describe("purge-deleted-documents", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = new Date("2026-10-12T00:00:00Z");
  const booking = (endsDaysAgo: number) => ({
    id: `apt-${endsDaysAgo}`,
    organizationId: null,
    organization: null,
    consultation: {
      status: "COMPLETED",
      cancelledAt: null,
      updatedAt: now,
      requestedBy: { id: "cp", userId: "u-l", user: { name: "L" } },
      consultationPlan: {
        title: "Plan",
        consultantProfile: { id: "xp", userId: "u-e", user: { name: "E" } },
      },
    },
    subscription: null,
    trial: null,
    occurrences: [
      {
        startsAt: new Date(now.getTime() - endsDaysAgo * DAY - 3600_000),
        endsAt: new Date(now.getTime() - endsDaysAgo * DAY),
      },
    ],
    statusHistory: [],
  });

  it("tombstones only bookings past their retention date, with the reason", async () => {
    (prisma.appointmentDocument.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.appointment.findMany as jest.Mock)
      .mockResolvedValueOnce([booking(91), booking(89)])
      .mockResolvedValueOnce([]);
    (prisma.appointment.findUnique as jest.Mock).mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        where.id === "apt-91" ? booking(91) : null,
    );
    (prisma.appointmentDocument.updateMany as jest.Mock).mockResolvedValue({
      count: 2,
    });

    const result = await purgeDeletedDocuments(now);

    expect(prisma.appointmentDocument.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.appointmentDocument.updateMany).toHaveBeenCalledWith({
      where: { appointmentId: "apt-91", deletedAt: null },
      data: { deletedAt: now, removalReason: "RETENTION_EXPIRY" },
    });
    expect(result.tombstoned).toBe(2);
  });

  it("matches retention history only on entities every deployed client knows", async () => {
    (prisma.appointmentDocument.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.appointment.findMany as jest.Mock).mockResolvedValue([]);

    await purgeDeletedDocuments(now);

    const known = {
      in: [
        "CONSULTATION",
        "SUBSCRIPTION",
        "WEBINAR",
        "CLASS",
        "TRIAL",
        "RESCHEDULE_REQUEST",
        "OCCURRENCE",
      ],
    };
    const { where, select } = (prisma.appointment.findMany as jest.Mock).mock
      .calls[0][0];
    expect(where.OR[0].statusHistory.some.entity).toEqual(known);
    // The date rule reads the terminal date through the same select.
    expect(select.statusHistory.where.entity).toEqual(known);
  });

  it("continues with the remaining bookings when one tombstone transaction fails", async () => {
    (prisma.appointmentDocument.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.appointment.findMany as jest.Mock)
      .mockResolvedValueOnce([booking(91), booking(92)])
      .mockResolvedValueOnce([]);
    (prisma.appointment.findUnique as jest.Mock).mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        where.id === "apt-91" ? booking(91) : booking(92),
    );
    (prisma.$transaction as jest.Mock).mockRejectedValueOnce(
      new Error("deadlock"),
    );
    (prisma.appointmentDocument.updateMany as jest.Mock).mockResolvedValue({
      count: 1,
    });

    const result = await purgeDeletedDocuments(now);

    expect(result.failedTombstones).toBe(1);
    expect(result.tombstoned).toBe(1);
    expect(result.success).toBe(false);
    expect(prisma.appointmentDocument.updateMany).toHaveBeenCalledTimes(1);
    expect(reportSentryMessage).toHaveBeenCalledTimes(1);
  });

  it("bounds the tombstone pass by the run limit", async () => {
    (prisma.appointmentDocument.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.appointment.findMany as jest.Mock)
      .mockResolvedValueOnce([booking(91), booking(92)])
      .mockResolvedValueOnce([]);
    (prisma.appointment.findUnique as jest.Mock).mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        where.id === "apt-91" ? booking(91) : booking(92),
    );
    (prisma.appointmentDocument.updateMany as jest.Mock).mockResolvedValue({
      count: 1,
    });

    const result = await purgeDeletedDocuments(now, { limit: 1 });

    expect(result.tombstoned).toBe(1);
    expect(prisma.appointmentDocument.updateMany).toHaveBeenCalledTimes(1);
  });

  it("purges versions before roots, retries surviving bytes and reports once", async () => {
    (prisma.appointmentDocument.findMany as jest.Mock)
      .mockResolvedValueOnce([
        {
          id: "v2",
          storagePath: "a/2.pdf",
          isStorageMissing: false,
          removalReason: "USER_REQUEST",
        },
        {
          id: "v3",
          storagePath: "a/3.pdf",
          isStorageMissing: false,
          removalReason: null,
        },
      ])
      .mockResolvedValueOnce([]);
    (deleteAppointmentDocument as jest.Mock).mockImplementation(
      async (path: string) => path === "a/2.pdf",
    );

    const result = await purgeDeletedDocuments(now);

    const where = (prisma.appointmentDocument.findMany as jest.Mock).mock
      .calls[0][0].where;
    const nested = (where.AND as Array<{ AND?: unknown[] }>).find((part) =>
      Array.isArray(part.AND),
    );
    expect(nested?.AND).toContainEqual({
      OR: [{ rootDocumentId: { not: null } }, { threadVersions: { none: {} } }],
    });
    expect(result).toMatchObject({
      purged: 1,
      failedStorage: 1,
      byReason: { USER_REQUEST: 1 },
      success: false,
    });
    expect(reportSentryMessage).toHaveBeenCalledTimes(1);
  });

  it("caps on attempts and keeps an object another row still references", async () => {
    (prisma.appointmentDocument.findMany as jest.Mock)
      .mockReset()
      .mockResolvedValue([])
      .mockResolvedValueOnce([
        { id: "d1", storagePath: "a/shared.pdf", isStorageMissing: false },
        { id: "d2", storagePath: "a/down.pdf", isStorageMissing: false },
        { id: "d3", storagePath: "a/never.pdf", isStorageMissing: false },
      ]);
    (prisma.appointmentDocument.count as jest.Mock).mockImplementation(
      async ({ where }: { where: { storagePath?: string } }) =>
        where.storagePath === "a/shared.pdf" ? 1 : 0,
    );
    (deleteAppointmentDocument as jest.Mock).mockResolvedValue(false);

    const result = await purgeDeletedDocuments(now, { limit: 2 });

    expect(deleteAppointmentDocument).toHaveBeenCalledTimes(1);
    expect(deleteAppointmentDocument).toHaveBeenCalledWith("a/down.pdf");
    expect(prisma.appointmentDocument.deleteMany).toHaveBeenCalledWith({
      where: { id: "d1" },
    });
    expect(result).toMatchObject({ purged: 1, failedStorage: 1 });
  });

  it("deletes a shared object when a concurrent purge removed its sibling", async () => {
    (prisma.appointmentDocument.findMany as jest.Mock)
      .mockReset()
      .mockResolvedValue([])
      .mockResolvedValueOnce([
        { id: "d1", storagePath: "a/shared.pdf", isStorageMissing: false },
      ]);
    // The sibling exists when d1 is checked, and is gone once d1's row is deleted.
    (prisma.appointmentDocument.count as jest.Mock)
      .mockReset()
      .mockResolvedValue(0)
      .mockResolvedValueOnce(1);
    (deleteAppointmentDocument as jest.Mock).mockResolvedValue(true);

    const result = await purgeDeletedDocuments(now, { limit: 10 });

    expect(prisma.appointmentDocument.deleteMany).toHaveBeenCalledWith({
      where: { id: "d1" },
    });
    expect(deleteAppointmentDocument).toHaveBeenCalledWith("a/shared.pdf");
    expect(result).toMatchObject({ purged: 1, failedStorage: 0 });
  });
});
