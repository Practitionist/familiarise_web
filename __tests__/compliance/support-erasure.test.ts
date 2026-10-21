/** @jest-environment node */

jest.mock("../../lib/supabase-storage-core", () => ({
  __esModule: true,
  removeObjects: jest.fn(async () => true),
}));

import { removeObjects } from "../../lib/supabase-storage-core";
import { unverifiedUserPurgeWhere } from "../../lib/auth/purge-unverified-users";
import {
  ERASED_SUPPORT_TEXT,
  removeSupportAttachmentObjects,
  scrubSupportPiiTx,
  supportRetainedHistoryCount,
} from "../../lib/support/erasure";

const count = (n: number) => ({ count: jest.fn(async () => n) });

describe("support history routes an erasure to the scrub path", () => {
  it("counts cases with decisions, evidence or files plus support rows the user authored", async () => {
    const db = {
      supportCase: count(1),
      supportCaseEvidenceRequest: count(2),
      supportCaseAttachment: count(0),
      supportCaseDecision: count(0),
      supportFinancialRecommendation: count(0),
    };
    await expect(supportRetainedHistoryCount(db as never, "u1")).resolves.toBe(
      3,
    );
    expect(db.supportCase.count).toHaveBeenCalledWith({
      where: {
        OR: [{ requesterUserId: "u1" }, { submitterUserId: "u1" }],
        AND: {
          OR: expect.arrayContaining([
            { decisions: { some: {} } },
            { evidenceRequests: { some: {} } },
            { attachments: { some: {} } },
          ]),
        },
      },
    });
  });

  it("is zero for a user whose cases a cascade can remove", async () => {
    const db = {
      supportCase: count(0),
      supportCaseEvidenceRequest: count(0),
      supportCaseAttachment: count(0),
      supportCaseDecision: count(0),
      supportFinancialRecommendation: count(0),
    };
    await expect(supportRetainedHistoryCount(db as never, "u1")).resolves.toBe(
      0,
    );
  });
});

describe("scrubSupportPiiTx", () => {
  const tx = {
    supportCase: { updateMany: jest.fn(async () => ({ count: 1 })) },
    supportCaseMessage: { updateMany: jest.fn(async () => ({ count: 2 })) },
    supportCaseEvidenceRequest: {
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    supportCaseAttachment: {
      findMany: jest.fn(async () => [
        { storagePath: "support-cases/c1/f1" },
        { storagePath: "support-cases/c1/f2" },
      ]),
      updateMany: jest.fn(async () => ({ count: 2 })),
    },
  };

  it("redacts case text, contact details, the user's messages and evidence responses", async () => {
    const now = new Date();
    const paths = await scrubSupportPiiTx(tx as never, "u1", now);

    expect(tx.supportCase.updateMany).toHaveBeenCalledWith({
      where: { OR: [{ requesterUserId: "u1" }, { submitterUserId: "u1" }] },
      data: expect.objectContaining({
        description: ERASED_SUPPORT_TEXT,
        callbackPhone: null,
        externalRequesterEmail: null,
        externalRequesterName: null,
      }),
    });
    expect(tx.supportCaseMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: expect.arrayContaining([{ authorUserId: "u1" }]),
        },
        data: expect.objectContaining({ body: ERASED_SUPPORT_TEXT }),
      }),
    );
    expect(tx.supportCaseEvidenceRequest.updateMany).toHaveBeenCalledWith({
      where: { recipientUserId: "u1", responseBody: { not: null } },
      data: { responseBody: ERASED_SUPPORT_TEXT },
    });
    expect(tx.supportCaseAttachment.updateMany).toHaveBeenCalledWith({
      where: { uploadedById: "u1", deletedAt: null },
      data: { deletedAt: now, originalName: ERASED_SUPPORT_TEXT },
    });
    expect(paths).toEqual(["support-cases/c1/f1", "support-cases/c1/f2"]);
    expect(removeObjects).not.toHaveBeenCalled();
  });

  it("deletes the collected objects after commit and reports an unconfirmed delete", async () => {
    await expect(
      removeSupportAttachmentObjects(["support-cases/c1/f1"]),
    ).resolves.toEqual([]);
    expect(removeObjects).toHaveBeenCalledWith("support-attachments", [
      "support-cases/c1/f1",
    ]);

    (removeObjects as jest.Mock).mockResolvedValueOnce(false);
    const failures = await removeSupportAttachmentObjects([
      "support-cases/c1/f2",
    ]);
    expect(failures[0]).toMatch(/^support_attachments: 1 file/);
  });
});

describe("unverified-account purge", () => {
  it("spares a user who is the requester on any support case", () => {
    expect(unverifiedUserPurgeWhere(new Date())).toMatchObject({
      supportCasesSubmitted: { none: {} },
      supportCasesRequested: { none: {} },
    });
  });
});
