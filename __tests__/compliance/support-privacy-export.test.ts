/** @jest-environment node */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    membership: { findMany: jest.fn(async () => []) },
    supportCase: { findMany: jest.fn() },
    supportCaseMessage: { findMany: jest.fn() },
    supportCaseEvidenceRequest: { findMany: jest.fn() },
    supportCaseAttachment: { findMany: jest.fn() },
  },
}));

import prisma from "../../lib/prisma";
import { readSupportExport } from "../../lib/support/privacy-export";

const db = prisma as unknown as {
  supportCase: { findMany: jest.Mock };
  supportCaseMessage: { findMany: jest.Mock };
  supportCaseEvidenceRequest: { findMany: jest.Mock };
  supportCaseAttachment: { findMany: jest.Mock };
};

const at = new Date("2026-10-01T00:00:00Z");
const ownCase = {
  id: "case-own",
  referenceNumber: "FAM-1",
  title: "Refund for session",
  description: "My card was charged twice",
  category: "GRIEVANCE",
  priority: "HIGH",
  status: "RESOLVED",
  ownershipScope: "PERSONAL",
  organizationId: null,
  requesterUserId: "u1",
  submitterUserId: "u1",
  callbackPhone: "+919999999999",
  callbackWindow: null,
  csatRating: 4,
  csatAt: at,
  createdAt: at,
  resolvedAt: at,
  closedAt: null,
};
const orgFiled = {
  ...ownCase,
  id: "case-org",
  referenceNumber: "FAM-2",
  title: "Operator notes about member",
  description: "Operator text",
  category: "OTHER",
  submitterUserId: "operator",
  csatRating: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  db.supportCase.findMany.mockResolvedValue([ownCase, orgFiled]);
  db.supportCaseMessage.findMany.mockResolvedValue([
    { id: "m1", caseId: "case-own", seq: 1, body: "My message", createdAt: at },
  ]);
  db.supportCaseEvidenceRequest.findMany.mockResolvedValue([
    {
      id: "e1",
      caseId: "case-x",
      prompt: "Describe the session",
      dueAt: at,
      responseBody: "It ended early",
      respondedAt: at,
      cancelledAt: null,
      createdAt: at,
    },
  ]);
  db.supportCaseAttachment.findMany.mockResolvedValue([
    {
      id: "f1",
      caseId: "case-own",
      evidenceRequestId: null,
      originalName: "receipt.pdf",
      mimeType: "application/pdf",
      fileSize: 1200,
      createdAt: at,
      completedAt: at,
      deletedAt: null,
    },
  ]);
});

describe("DPDP export of the support record", () => {
  it("includes the user's cases, grievances, own messages, evidence, files and ratings", async () => {
    const out = await readSupportExport("u1");

    expect(out.supportTickets).toHaveLength(2);
    expect(out.supportGrievances.map((c) => c.id)).toEqual(["case-own"]);
    expect(out.supportMessages).toEqual([
      expect.objectContaining({ body: "My message" }),
    ]);
    expect(out.supportEvidenceRequests).toEqual([
      expect.objectContaining({
        prompt: "Describe the session",
        responseBody: "It ended early",
      }),
    ]);
    expect(out.supportAttachments).toEqual([
      expect.objectContaining({ originalName: "receipt.pdf" }),
    ]);
    expect(out.supportRatings).toEqual([
      { caseId: "case-own", rating: 4, ratedAt: at },
    ]);
    expect(out.supportExportComplete).toBe(true);
    expect(db.supportCaseMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { authorUserId: "u1", isInternal: false },
      }),
    );
  });

  it("shows an organization-filed case only as a summary", async () => {
    const out = await readSupportExport("u1");
    const summary = out.supportTickets.find((c) => c.id === "case-org");
    expect(summary).toMatchObject({
      title: "Organization support request",
      filedByOrganization: true,
    });
    expect(JSON.stringify(summary)).not.toContain("Operator");
  });

  it("pages through every row instead of truncating", async () => {
    const page = (start: number, size: number) =>
      Array.from({ length: size }, (_, i) => ({
        id: `m${start + i}`,
        caseId: "case-own",
        seq: start + i,
        body: "x",
        createdAt: at,
      }));
    db.supportCaseMessage.findMany
      .mockResolvedValueOnce(page(0, 500))
      .mockResolvedValueOnce(page(500, 3));

    const out = await readSupportExport("u1");

    expect(out.supportMessages).toHaveLength(503);
    expect(db.supportCaseMessage.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: { id: "m499" }, skip: 1, take: 500 }),
    );
  });

  it("treats an exactly full page followed by an empty one as complete", async () => {
    db.supportCaseMessage.findMany
      .mockResolvedValueOnce(messagePage(0, 500))
      .mockResolvedValueOnce([]);

    const out = await readSupportExport("u1");

    expect(out.supportMessages).toHaveLength(500);
    expect(out.supportExportComplete).toBe(true);
    expect(db.supportCaseMessage.findMany).toHaveBeenCalledTimes(2);
  });

  it("flags the export incomplete when a collection reaches the row bound", async () => {
    let next = 0;
    db.supportCaseMessage.findMany.mockImplementation(async () => {
      const rows = messagePage(next, 500);
      next += 500;
      return rows;
    });

    const out = await readSupportExport("u1");

    expect(out.supportMessages).toHaveLength(20_000);
    expect(out.supportExportComplete).toBe(false);
  });
});

function messagePage(start: number, size: number) {
  return Array.from({ length: size }, (_, i) => ({
    id: `m${start + i}`,
    caseId: "case-own",
    seq: start + i,
    body: "x",
    createdAt: at,
  }));
}
