/** @jest-environment node */
const mockRemoveObjects = jest.fn(
  async (_bucket: string, _paths: string[]) => true,
);
jest.mock("../../lib/supabase-storage-core", () => ({
  removeObjects: (bucket: string, paths: string[]) =>
    mockRemoveObjects(bucket, paths),
}));
jest.mock("../../lib/prisma", () => {
  const tx = {
    supportCase: { updateMany: jest.fn() },
    supportCaseAttachment: { updateMany: jest.fn() },
    supportCaseMessage: { updateMany: jest.fn() },
    supportCaseEvidenceRequest: { updateMany: jest.fn() },
    supportCaseEvent: { create: jest.fn(), updateMany: jest.fn() },
  };
  const db = {
    dispute: { findMany: jest.fn() },
    supportCase: { findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    tx,
  };
  return {
    __esModule: true,
    default: db,
    ALLOCATION_TX_MAX_WAIT_MS: 1000,
    ALLOCATION_TX_TIMEOUT_MS: 1000,
  };
});

import { Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";
import { purgeExpiredSupportEvidence } from "../../lib/support/evidence-retention";

const db = prisma as unknown as {
  dispute: { findMany: jest.Mock };
  supportCase: { findMany: jest.Mock; count: jest.Mock };
  $transaction: jest.Mock;
  tx: {
    supportCase: { updateMany: jest.Mock };
    supportCaseAttachment: { updateMany: jest.Mock };
    supportCaseMessage: { updateMany: jest.Mock };
    supportCaseEvidenceRequest: { updateMany: jest.Mock };
    supportCaseEvent: { create: jest.Mock; updateMany: jest.Mock };
  };
};
const DAY = 24 * 3_600_000;
const now = new Date("2026-10-22T00:00:00Z");
const cutoff = new Date(now.getTime() - 180 * DAY);

beforeEach(() => {
  jest.clearAllMocks();
  mockRemoveObjects.mockResolvedValue(true);
  db.dispute.findMany.mockResolvedValue([]);
  db.supportCase.findMany.mockResolvedValue([]);
  db.supportCase.count.mockResolvedValue(1);
  db.tx.supportCase.updateMany.mockResolvedValue({ count: 1 });
});

function eligibilityWhere(): Prisma.SupportCaseWhereInput {
  return db.supportCase.findMany.mock.calls[0][0].where;
}

it("selects cases closed 180+ days ago with no hold, no recent appeal and no purge yet, overscanned and oldest first", async () => {
  await purgeExpiredSupportEvidence({ limit: 4, now, errors: [] });
  const args = db.supportCase.findMany.mock.calls[0][0];
  expect(args.take).toBe(16);
  expect(args.orderBy).toEqual([{ closedAt: "asc" }, { id: "asc" }]);
  expect(args.where).toMatchObject({
    closedAt: { lte: cutoff },
    legalHoldAt: null,
    events: { none: { kind: "EVIDENCE_PURGED" } },
    decisions: {
      none: {
        appeals: {
          some: { OR: [{ closedAt: null }, { closedAt: { gt: cutoff } }] },
        },
      },
    },
    AND: [
      {
        OR: [
          { appealOfDecisionId: null },
          { appealOfDecision: { supportCase: { closedAt: { lte: cutoff } } } },
        ],
      },
    ],
  });
  expect(args.where).not.toHaveProperty("subjects");
});

it("excludes cases linked to a payment under a live dispute (derived hold)", async () => {
  db.dispute.findMany.mockResolvedValue([
    {
      paymentId: "pay-1",
      payment: { appointmentId: "apt-1", refunds: [{ id: "ref-1" }] },
    },
  ]);
  await purgeExpiredSupportEvidence({ limit: 4, now, errors: [] });
  const disputeWhere = db.dispute.findMany.mock.calls[0][0].where;
  expect(disputeWhere.status.notIn).toEqual(
    expect.arrayContaining(["WON", "LOST", "CHARGE_REFUNDED", "CLOSED"]),
  );
  expect(disputeWhere.status.notIn).not.toContain("NEEDS_RESPONSE");
  const where = eligibilityWhere();
  expect(where.subjects).toEqual({
    none: {
      OR: [
        { subjectType: "PAYMENT", subjectId: { in: ["pay-1"] } },
        { subjectType: "APPOINTMENT", subjectId: { in: ["apt-1"] } },
        { subjectType: "REFUND", subjectId: { in: ["ref-1"] } },
      ],
    },
  });
  expect(where.recommendations).toEqual({
    none: { paymentId: { in: ["pay-1"] } },
  });
  expect(where.AND).toContainEqual({
    OR: [{ appointmentId: null }, { appointmentId: { notIn: ["apt-1"] } }],
  });
});

it("deletes the files, then scrubs free text and records one EVIDENCE_PURGED event, keeping decisions untouched", async () => {
  db.supportCase.findMany.mockResolvedValue([
    {
      id: "case-1",
      attachments: [{ storagePath: "c1/a.png" }, { storagePath: "c1/b.pdf" }],
    },
  ]);
  const errors: string[] = [];
  const result = await purgeExpiredSupportEvidence({ limit: 4, now, errors });

  expect(errors).toEqual([]);
  expect(result).toEqual({ casesPurged: 1, filesDeleted: 2 });
  expect(mockRemoveObjects).toHaveBeenCalledWith("support-attachments", [
    "c1/a.png",
    "c1/b.pdf",
  ]);
  expect(mockRemoveObjects.mock.invocationCallOrder[0]).toBeLessThan(
    db.$transaction.mock.invocationCallOrder[0],
  );
  expect(db.tx.supportCaseAttachment.updateMany).toHaveBeenCalledWith({
    where: { caseId: "case-1", deletedAt: null },
    data: { deletedAt: now },
  });
  expect(db.tx.supportCaseAttachment.updateMany).toHaveBeenCalledWith({
    where: { caseId: "case-1" },
    data: { originalName: expect.any(String) },
  });
  const scrub = db.tx.supportCase.updateMany.mock.calls[0][0];
  expect(scrub.where).toMatchObject({ id: "case-1", legalHoldAt: null });
  expect(scrub.data).toEqual({
    title: "Support request",
    description: expect.any(String),
    callbackPhone: null,
    callbackWindow: null,
    externalRequesterEmail: null,
    externalRequesterName: null,
  });
  expect(scrub.data).not.toHaveProperty("status");
  expect(scrub.data).not.toHaveProperty("referenceNumber");
  expect(db.tx.supportCaseMessage.updateMany).toHaveBeenCalledWith({
    where: { caseId: "case-1" },
    data: { body: expect.any(String), metadata: Prisma.DbNull },
  });
  expect(db.tx.supportCaseEvidenceRequest.updateMany).toHaveBeenCalledWith({
    where: { caseId: "case-1" },
    data: { prompt: expect.any(String) },
  });
  expect(db.tx.supportCaseEvidenceRequest.updateMany).toHaveBeenCalledWith({
    where: { caseId: "case-1", responseBody: { not: null } },
    data: { responseBody: expect.any(String) },
  });
  expect(db.tx.supportCaseEvent.updateMany).toHaveBeenCalledWith({
    where: {
      caseId: "case-1",
      note: { not: null },
      kind: {
        notIn: [
          "HOLD_APPLIED",
          "HOLD_RELEASED",
          "RECOMMENDATION_PROPOSED",
          "RECOMMENDATION_DECIDED",
          "RECOMMENDATION_VOIDED",
          "DECISION_RECORDED",
          "LEGAL_HOLD_CHANGED",
          "EVIDENCE_PURGED",
        ],
      },
    },
    data: { note: null },
  });
  const scrubbedKinds =
    db.tx.supportCaseEvent.updateMany.mock.calls[0][0].where.kind.notIn;
  expect(scrubbedKinds).not.toContain("STATUS_CHANGED");
  expect(scrubbedKinds).not.toContain("REOPENED");
  expect(db.tx.supportCaseEvent.create).toHaveBeenCalledTimes(1);
  expect(db.tx.supportCaseEvent.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      caseId: "case-1",
      kind: "EVIDENCE_PURGED",
      createdAt: now,
    }),
  });
  expect(db.tx).not.toHaveProperty("supportCaseDecision");
});

it("leaves the case whole and reports when storage does not confirm the delete", async () => {
  db.supportCase.findMany.mockResolvedValue([
    { id: "case-1", attachments: [{ storagePath: "c1/a.png" }] },
    { id: "case-2", attachments: [] },
  ]);
  mockRemoveObjects.mockResolvedValueOnce(false);
  const errors: string[] = [];
  const result = await purgeExpiredSupportEvidence({ limit: 4, now, errors });

  expect(errors).toEqual([
    "evidence-purge case case-1: 1 file(s) not confirmed deleted",
  ]);
  expect(result).toEqual({ casesPurged: 1, filesDeleted: 0 });
  expect(db.$transaction).toHaveBeenCalledTimes(1);
  expect(db.tx.supportCaseAttachment.updateMany).not.toHaveBeenCalledWith(
    expect.objectContaining({ where: { caseId: "case-1", deletedAt: null } }),
  );
});

it("does not touch storage for a case that gained a hold after the scan", async () => {
  db.supportCase.findMany.mockResolvedValue([
    { id: "case-1", attachments: [{ storagePath: "c1/a.png" }] },
  ]);
  db.supportCase.count.mockResolvedValue(0);
  const result = await purgeExpiredSupportEvidence({
    limit: 4,
    now,
    errors: [],
  });
  expect(mockRemoveObjects).not.toHaveBeenCalled();
  expect(db.$transaction).not.toHaveBeenCalled();
  expect(result.casesPurged).toBe(0);
});

it("on a CAS miss marks the deleted files only: no rename, no scrub, no event", async () => {
  db.supportCase.findMany.mockResolvedValue([
    { id: "case-1", attachments: [{ storagePath: "c1/a.png" }] },
  ]);
  db.tx.supportCase.updateMany.mockResolvedValue({ count: 0 });
  const errors: string[] = [];
  const result = await purgeExpiredSupportEvidence({ limit: 4, now, errors });

  expect(result).toEqual({ casesPurged: 0, filesDeleted: 0 });
  expect(errors).toHaveLength(1);
  expect(db.tx.supportCase.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
    db.tx.supportCaseAttachment.updateMany.mock.invocationCallOrder[0],
  );
  expect(db.tx.supportCaseAttachment.updateMany).toHaveBeenCalledTimes(1);
  expect(db.tx.supportCaseAttachment.updateMany).toHaveBeenCalledWith({
    where: { caseId: "case-1", deletedAt: null },
    data: { deletedAt: now },
  });
  expect(db.tx.supportCaseMessage.updateMany).not.toHaveBeenCalled();
  expect(db.tx.supportCaseEvidenceRequest.updateMany).not.toHaveBeenCalled();
  expect(db.tx.supportCaseEvent.updateMany).not.toHaveBeenCalled();
  expect(db.tx.supportCaseEvent.create).not.toHaveBeenCalled();
});

it("cases that keep failing storage do not block an eligible case behind them", async () => {
  const stuck = Array.from({ length: 5 }, (_, i) => ({
    id: `stuck-${i}`,
    attachments: [{ storagePath: `stuck/${i}` }],
  }));
  db.supportCase.findMany.mockResolvedValue([
    ...stuck,
    { id: "ready", attachments: [{ storagePath: "ready/a" }] },
    { id: "next", attachments: [] },
  ]);
  mockRemoveObjects.mockImplementation(
    async (_bucket: string, paths: string[]) => !paths[0].startsWith("stuck/"),
  );
  const errors: string[] = [];
  const result = await purgeExpiredSupportEvidence({ limit: 2, now, errors });

  expect(db.supportCase.findMany.mock.calls[0][0].take).toBe(8);
  expect(result).toEqual({ casesPurged: 2, filesDeleted: 1 });
  expect(errors).toHaveLength(5);
  expect(db.tx.supportCaseEvent.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ caseId: "ready", kind: "EVIDENCE_PURGED" }),
  });
});

it("stops once limit cases are purged", async () => {
  db.supportCase.findMany.mockResolvedValue(
    ["a", "b", "c"].map((id) => ({ id, attachments: [] })),
  );
  const result = await purgeExpiredSupportEvidence({
    limit: 2,
    now,
    errors: [],
  });
  expect(result.casesPurged).toBe(2);
  expect(db.$transaction).toHaveBeenCalledTimes(2);
  expect(db.supportCase.count).toHaveBeenCalledTimes(2);
});

it("skips the run when the live-dispute set reaches its cap", async () => {
  db.dispute.findMany.mockResolvedValue(
    Array.from({ length: 2_000 }, (_, i) => ({
      paymentId: `p${i}`,
      payment: { appointmentId: null, refunds: [] },
    })),
  );
  const errors: string[] = [];
  await purgeExpiredSupportEvidence({ limit: 4, now, errors });
  expect(db.supportCase.findMany).not.toHaveBeenCalled();
  expect(errors).toHaveLength(1);
});

it("batches large attachment sets in chunks of 100", async () => {
  db.supportCase.findMany.mockResolvedValue([
    {
      id: "case-1",
      attachments: Array.from({ length: 150 }, (_, i) => ({
        storagePath: `c1/${i}`,
      })),
    },
  ]);
  await purgeExpiredSupportEvidence({ limit: 4, now, errors: [] });
  expect(mockRemoveObjects).toHaveBeenCalledTimes(2);
  expect(mockRemoveObjects.mock.calls[0][1]).toHaveLength(100);
  expect(mockRemoveObjects.mock.calls[1][1]).toHaveLength(50);
});
