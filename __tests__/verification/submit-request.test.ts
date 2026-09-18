/**
 * @jest-environment node
 */
/**
 * The one submission writer: CAS on the profile, supersede the open row, link
 * only owned unlinked documents, refuse an empty request.
 */

const tx = {
  consultantProfile: { findUnique: jest.fn(), updateMany: jest.fn() },
  consultantProfileVerification: {
    findFirst: jest.fn(),
    updateMany: jest.fn(),
    create: jest.fn(),
    count: jest.fn(),
  },
  profileVerificationDocument: { updateMany: jest.fn(), count: jest.fn() },
  user: { update: jest.fn() },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  },
}));

import { submitVerificationRequest } from "../../lib/verification/submit-request";

const base = {
  userId: "u1",
  consultantProfileId: "cp1",
  documentIds: ["d1", "d2"],
  carryOver: false,
};

function primeHappyPath() {
  tx.consultantProfile.findUnique.mockResolvedValue({
    userId: "u1",
    verificationStatus: "PENDING_VERIFICATION",
  });
  tx.consultantProfile.updateMany.mockResolvedValue({ count: 1 });
  tx.consultantProfileVerification.findFirst
    .mockResolvedValueOnce({ id: "open1" }) // the open row to supersede
    .mockResolvedValueOnce(null); // last decision (for the round count)
  tx.consultantProfileVerification.updateMany.mockResolvedValue({ count: 1 });
  tx.consultantProfileVerification.count.mockResolvedValue(0);
  tx.consultantProfileVerification.create.mockResolvedValue({ id: "new1" });
  tx.profileVerificationDocument.updateMany.mockResolvedValue({ count: 2 });
  tx.profileVerificationDocument.count.mockResolvedValue(2);
}

beforeEach(() => {
  for (const model of Object.values(tx)) {
    for (const fn of Object.values(model)) (fn as jest.Mock).mockReset();
  }
});

describe("submitVerificationRequest", () => {
  it("claims the profile, supersedes the open row and links owned documents", async () => {
    primeHappyPath();
    const outcome = await submitVerificationRequest(base);
    expect(outcome).toMatchObject({
      ok: true,
      verificationId: "new1",
      supersededId: "open1",
      documentCount: 2,
      round: 1,
    });
    expect(tx.consultantProfile.updateMany).toHaveBeenCalledWith({
      where: {
        id: "cp1",
        verificationStatus: { in: ["PENDING_VERIFICATION", "REJECTED"] },
      },
      data: { verificationStatus: "UNDER_REVIEW", isVerified: false },
    });
    expect(tx.profileVerificationDocument.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ["d1", "d2"] },
          uploadedByUserId: "u1",
          verificationId: null,
        },
      }),
    );
  });

  it("loses the CAS when a submission is already under review", async () => {
    primeHappyPath();
    tx.consultantProfile.findUnique.mockResolvedValue({
      userId: "u1",
      verificationStatus: "UNDER_REVIEW",
    });
    tx.consultantProfile.updateMany.mockResolvedValue({ count: 0 });
    const outcome = await submitVerificationRequest(base);
    expect(outcome).toMatchObject({ ok: false, code: "NOT_SUBMITTABLE" });
    expect(tx.consultantProfileVerification.create).not.toHaveBeenCalled();
  });

  it("refuses when a document is not the caller's or already linked (#1224)", async () => {
    primeHappyPath();
    tx.profileVerificationDocument.updateMany.mockResolvedValue({ count: 1 });
    const outcome = await submitVerificationRequest(base);
    expect(outcome).toMatchObject({ ok: false, code: "DOCUMENTS_NOT_OWNED" });
  });

  it("refuses a request that would carry no document", async () => {
    primeHappyPath();
    tx.profileVerificationDocument.count.mockResolvedValue(0);
    const outcome = await submitVerificationRequest({
      ...base,
      documentIds: [],
    });
    expect(outcome).toMatchObject({ ok: false, code: "NO_DOCUMENTS" });
  });

  it("refuses a profile that is not the caller's", async () => {
    primeHappyPath();
    tx.consultantProfile.findUnique.mockResolvedValue({
      userId: "someone-else",
      verificationStatus: "PENDING_VERIFICATION",
    });
    const outcome = await submitVerificationRequest(base);
    expect(outcome).toMatchObject({ ok: false, code: "PROFILE_NOT_FOUND" });
  });
});
