/**
 * @jest-environment node
 */
/**
 * The one review writer: reason codes on flagged documents, a CAS on the open
 * row, the NEEDS_INFO round cap, and the profile flip.
 */

const tx = {
  consultantProfileVerification: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    updateMany: jest.fn(),
  },
  profileVerificationDocument: { updateMany: jest.fn() },
  consultantProfile: { update: jest.fn(), findUnique: jest.fn() },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  },
}));
jest.mock("../../lib/profiles/profile-completion", () => ({
  __esModule: true,
  recomputeProfileCompletion: jest.fn(async () => 50),
}));

import {
  findFeedbackWithoutIssue,
  MAX_NEEDS_INFO_ROUNDS,
  reviewVerification,
} from "../../lib/verification/review";

const base = {
  verificationId: "v1",
  reviewerId: "staff1",
};

function primeOpenRequest(round = 0) {
  tx.consultantProfileVerification.findUnique.mockResolvedValue({
    status: "PENDING",
    consultantProfileId: "cp1",
    consultantProfile: { userId: "u1" },
  });
  tx.consultantProfileVerification.findFirst.mockResolvedValue(null);
  tx.consultantProfileVerification.count.mockResolvedValue(round);
  tx.consultantProfileVerification.updateMany.mockResolvedValue({ count: 1 });
  tx.profileVerificationDocument.updateMany.mockResolvedValue({ count: 1 });
  tx.consultantProfile.update.mockResolvedValue({});
}

beforeEach(() => {
  for (const model of Object.values(tx)) {
    for (const fn of Object.values(model)) (fn as jest.Mock).mockReset();
  }
});

describe("findFeedbackWithoutIssue", () => {
  it("names the first flagged document with no reason code", () => {
    expect(
      findFeedbackWithoutIssue([
        { documentId: "a", isValid: true },
        { documentId: "b", isValid: false, issue: "EXPIRED" },
        { documentId: "c", isValid: false },
      ]),
    ).toBe("c");
    expect(findFeedbackWithoutIssue(undefined)).toBeNull();
  });
});

describe("reviewVerification", () => {
  it("approves: CAS from an open state, profile VERIFIED + isVerified", async () => {
    primeOpenRequest();
    const outcome = await reviewVerification({ ...base, status: "APPROVED" });
    expect(outcome).toMatchObject({ ok: true, profileStatus: "VERIFIED" });
    expect(tx.consultantProfileVerification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "v1", status: { in: ["PENDING", "NEEDS_INFO"] } },
      }),
    );
    expect(tx.consultantProfile.update).toHaveBeenCalledWith({
      where: { id: "cp1" },
      data: { verificationStatus: "VERIFIED", isVerified: true },
    });
  });

  it("refuses to decide an already-decided row", async () => {
    primeOpenRequest();
    tx.consultantProfileVerification.findUnique.mockResolvedValue({
      status: "APPROVED",
      consultantProfileId: "cp1",
      consultantProfile: { userId: "u1" },
    });
    tx.consultantProfileVerification.updateMany.mockResolvedValue({ count: 0 });
    const outcome = await reviewVerification({ ...base, status: "REJECTED" });
    expect(outcome).toMatchObject({ ok: false, code: "ALREADY_DECIDED" });
    expect(tx.consultantProfile.update).not.toHaveBeenCalled();
  });

  it("refuses a flagged document without a reason before touching the database", async () => {
    primeOpenRequest();
    const outcome = await reviewVerification({
      ...base,
      status: "NEEDS_INFO",
      rejectionReason: "Blurry",
      documentFeedback: [{ documentId: "d1", isValid: false }],
    });
    expect(outcome).toMatchObject({ ok: false, code: "ISSUE_REQUIRED" });
    expect(tx.consultantProfileVerification.findUnique).not.toHaveBeenCalled();
  });

  it("caps NEEDS_INFO at the round limit but still allows a final decision", async () => {
    primeOpenRequest(MAX_NEEDS_INFO_ROUNDS);
    const capped = await reviewVerification({ ...base, status: "NEEDS_INFO" });
    expect(capped).toMatchObject({ ok: false, code: "ROUND_CAP" });

    primeOpenRequest(MAX_NEEDS_INFO_ROUNDS);
    const rejected = await reviewVerification({ ...base, status: "REJECTED" });
    expect(rejected).toMatchObject({ ok: true, profileStatus: "REJECTED" });
  });

  it("only NEEDS_INFO from PENDING; a NEEDS_INFO row cannot be asked again", async () => {
    primeOpenRequest();
    await reviewVerification({ ...base, status: "NEEDS_INFO" });
    expect(tx.consultantProfileVerification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "v1", status: { in: ["PENDING"] } },
      }),
    );
  });
});
