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
    $executeRaw: jest.fn(),
    supportCase: { count: jest.fn(), update: jest.fn() },
    supportCaseAttachment: { findMany: jest.fn(), updateMany: jest.fn() },
    supportCaseMessage: { updateMany: jest.fn() },
    supportCaseEvidenceRequest: { updateMany: jest.fn() },
    supportCaseEvent: { create: jest.fn(), updateMany: jest.fn() },
  };
  const db = {
    dispute: { findMany: jest.fn() },
    supportCase: { findMany: jest.fn() },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    tx,
  };
  return { __esModule: true, default: db, ALLOCATION_TX_MAX_WAIT_MS: 1000 };
});

import { Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";
import { purgeExpiredSupportEvidence } from "../../lib/support/evidence-retention";

const db = prisma as unknown as {
  dispute: { findMany: jest.Mock };
  supportCase: { findMany: jest.Mock };
  $transaction: jest.Mock;
  tx: {
    $executeRaw: jest.Mock;
    supportCase: { count: jest.Mock; update: jest.Mock };
    supportCaseAttachment: { findMany: jest.Mock; updateMany: jest.Mock };
    supportCaseMessage: { updateMany: jest.Mock };
    supportCaseEvidenceRequest: { updateMany: jest.Mock };
    supportCaseEvent: { create: jest.Mock; updateMany: jest.Mock };
  };
};
const DAY = 24 * 3_600_000;
const now = new Date("2026-10-22T00:00:00Z");
const cutoff = new Date(now.getTime() - 180 * DAY);
let files: Record<string, string[]> = {};

function seedCases(byCase: Record<string, string[]>) {
  files = byCase;
  db.supportCase.findMany.mockResolvedValue(
    Object.keys(byCase).map((id) => ({ id })),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  files = {};
  mockRemoveObjects.mockResolvedValue(true);
  db.dispute.findMany.mockResolvedValue([]);
  db.supportCase.findMany.mockResolvedValue([]);
  db.tx.supportCase.count.mockResolvedValue(1);
  db.tx.supportCaseAttachment.findMany.mockImplementation(
    async ({ where }: { where: { caseId: string } }) =>
      (files[where.caseId] ?? []).map((storagePath) => ({ storagePath })),
  );
});

function eligibilityWhere(): Prisma.SupportCaseWhereInput {
  return db.supportCase.findMany.mock.calls[0][0].where;
}

function lockedCaseIds(): string[] {
  return db.tx.$executeRaw.mock.calls.map((call) => call[1]);
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

it("locks the case row, re-checks eligibility, deletes the files and scrubs in that one transaction", async () => {
  seedCases({ "case-1": ["c1/a.png", "c1/b.pdf"] });
  const errors: string[] = [];
  const result = await purgeExpiredSupportEvidence({ limit: 4, now, errors });

  expect(errors).toEqual([]);
  expect(result).toEqual({ casesPurged: 1, filesDeleted: 2 });
  expect(db.$transaction).toHaveBeenCalledTimes(1);
  const lockSql = (db.tx.$executeRaw.mock.calls[0][0] as string[]).join("?");
  expect(lockSql).toMatch(/FROM "SupportCase" WHERE id = \? FOR UPDATE/);
  expect(lockedCaseIds()).toEqual(["case-1"]);
  expect(db.tx.supportCase.count).toHaveBeenCalledWith({
    where: expect.objectContaining({ id: "case-1", legalHoldAt: null }),
  });
  const lockAt = db.tx.$executeRaw.mock.invocationCallOrder[0];
  const recheckAt = db.tx.supportCase.count.mock.invocationCallOrder[0];
  const storageAt = mockRemoveObjects.mock.invocationCallOrder[0];
  const scrubAt = db.tx.supportCase.update.mock.invocationCallOrder[0];
  expect(lockAt).toBeLessThan(recheckAt);
  expect(recheckAt).toBeLessThan(storageAt);
  expect(storageAt).toBeLessThan(scrubAt);
  expect(mockRemoveObjects).toHaveBeenCalledWith("support-attachments", [
    "c1/a.png",
    "c1/b.pdf",
  ]);
  expect(db.$transaction.mock.calls[0][1]).toEqual(
    expect.objectContaining({ timeout: 60_000 }),
  );

  expect(db.tx.supportCase.update).toHaveBeenCalledWith({
    where: { id: "case-1" },
    data: {
      title: "Support case",
      description: expect.any(String),
      callbackPhone: null,
      callbackWindow: null,
      externalRequesterEmail: null,
      externalRequesterName: null,
    },
  });
  expect(db.tx.supportCaseAttachment.updateMany).toHaveBeenCalledWith({
    where: { caseId: "case-1", deletedAt: null },
    data: { deletedAt: now },
  });
  expect(db.tx.supportCaseAttachment.updateMany).toHaveBeenCalledWith({
    where: { caseId: "case-1" },
    data: { originalName: expect.any(String) },
  });
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
          "CHAT_ACCESS_GRANTED",
          "CHAT_ACCESS_ENDED",
          "CHAT_SUPPORT_MESSAGE",
          "CHAT_REVIEW_NOTIFIED",
        ],
      },
    },
    data: { note: null },
  });
  expect(db.tx.supportCaseEvent.create).toHaveBeenCalledTimes(1);
  expect(db.tx.supportCaseEvent.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      caseId: "case-1",
      kind: "EVIDENCE_PURGED",
      toValue: "2",
      createdAt: now,
    }),
  });
  expect(db.tx).not.toHaveProperty("supportCaseDecision");
});

it("a case on legal hold by the time its lock is taken keeps its files and text", async () => {
  seedCases({ "case-1": ["c1/a.png"] });
  db.tx.supportCase.count.mockResolvedValue(0);
  const errors: string[] = [];
  const result = await purgeExpiredSupportEvidence({ limit: 4, now, errors });

  expect(lockedCaseIds()).toEqual(["case-1"]);
  expect(mockRemoveObjects).not.toHaveBeenCalled();
  expect(db.tx.supportCase.update).not.toHaveBeenCalled();
  expect(db.tx.supportCaseAttachment.updateMany).not.toHaveBeenCalled();
  expect(db.tx.supportCaseEvent.create).not.toHaveBeenCalled();
  expect(result.casesPurged).toBe(0);
  expect(errors).toEqual([]);
});

it("writes nothing and reports when storage does not confirm the delete", async () => {
  seedCases({ "case-1": ["c1/a.png"], "case-2": [] });
  mockRemoveObjects.mockResolvedValueOnce(false);
  const errors: string[] = [];
  const result = await purgeExpiredSupportEvidence({ limit: 4, now, errors });

  expect(errors).toEqual([
    "evidence-purge case case-1: 1 file(s) not confirmed deleted",
  ]);
  expect(result).toEqual({ casesPurged: 1, filesDeleted: 0 });
  expect(db.tx.supportCase.update).toHaveBeenCalledTimes(1);
  expect(db.tx.supportCase.update).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: "case-2" } }),
  );
  expect(db.tx.supportCaseAttachment.updateMany).not.toHaveBeenCalledWith(
    expect.objectContaining({ where: { caseId: "case-1", deletedAt: null } }),
  );
});

it("a failed transaction goes to errors and the next case still runs", async () => {
  seedCases({ "case-1": [], "case-2": [] });
  db.tx.supportCase.update.mockRejectedValueOnce(new Error("lock timeout"));
  const errors: string[] = [];
  const result = await purgeExpiredSupportEvidence({ limit: 4, now, errors });
  expect(errors).toEqual(["evidence-purge case case-1: lock timeout"]);
  expect(result.casesPurged).toBe(1);
});

it("cases that keep failing storage do not block an eligible case behind them", async () => {
  seedCases({
    ...Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`stuck-${i}`, [`stuck/${i}`]]),
    ),
    ready: ["ready/a"],
    next: [],
  });
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
  seedCases({ a: [], b: [], c: [] });
  const result = await purgeExpiredSupportEvidence({
    limit: 2,
    now,
    errors: [],
  });
  expect(result.casesPurged).toBe(2);
  expect(db.$transaction).toHaveBeenCalledTimes(2);
  expect(lockedCaseIds()).toEqual(["a", "b"]);
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
  seedCases({
    "case-1": Array.from({ length: 150 }, (_, i) => `c1/${i}`),
  });
  await purgeExpiredSupportEvidence({ limit: 4, now, errors: [] });
  expect(mockRemoveObjects).toHaveBeenCalledTimes(2);
  expect(mockRemoveObjects.mock.calls[0][1]).toHaveLength(100);
  expect(mockRemoveObjects.mock.calls[1][1]).toHaveLength(50);
});
