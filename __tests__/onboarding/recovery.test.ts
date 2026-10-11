/**
 * @jest-environment node
 */

/**
 * processOnboardingData: the CAS claim is the first write, a lost claim never
 * rewrites profile rows, and recovery reports success only when the stored
 * role matches and the account is fully onboarded.
 */

jest.mock("server-only", () => ({}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/verification/notify-admins", () => ({
  attemptBellsAfterResponse: jest.fn(),
}));
jest.mock("../../lib/verification/submit-request", () => ({
  submitVerificationRequest: jest.fn(),
}));
jest.mock("../../lib/profiles/profile-completion", () => ({
  recomputeProfileCompletion: jest.fn(),
}));
jest.mock("../../lib/compliance/dpdp", () => ({
  ensureConsentPurposes: jest.fn(),
}));

const tx = {
  user: { updateMany: jest.fn(), update: jest.fn() },
  consulteeProfile: { upsert: jest.fn() },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    user: { findUnique: jest.fn() },
  },
}));

import { Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";
import { ensureConsentPurposes } from "../../lib/compliance/dpdp";
import { processOnboardingData } from "../../utils/onboarding-server";

const USER_ID = "user-1";
const mockTransaction = prisma.$transaction as unknown as jest.Mock;
const mockFindUnique = prisma.user.findUnique as unknown as jest.Mock;
const mockEnsureConsent = ensureConsentPurposes as unknown as jest.Mock;

const consulteeBody = (overrides: Record<string, unknown> = {}) => ({
  role: "CONSULTEE",
  name: "Ada Lovelace",
  email: "ada@example.com",
  dateOfBirth: "1990-06-15",
  consulteeProfile: { create: {} },
  termsAccepted: true,
  privacyAccepted: true,
  ...overrides,
});

function storedUser(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    role: "CONSULTEE",
    onboardingCompleted: true,
    consultantProfileId: null,
    consulteeProfileId: "cee_1",
    staffProfileId: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTransaction.mockImplementation(async (fn: (t: typeof tx) => unknown) =>
    fn(tx),
  );
  mockFindUnique.mockImplementation(async (args: { select?: unknown }) =>
    args.select ? { id: USER_ID } : storedUser(),
  );
  tx.user.updateMany.mockResolvedValue({ count: 1 });
  tx.consulteeProfile.upsert.mockResolvedValue({ id: "cee_1" });
  tx.user.update.mockResolvedValue(storedUser());
});

describe("processOnboardingData claim-first CAS", () => {
  it("claims before any profile write and stamps consent server-side", async () => {
    const order: string[] = [];
    tx.user.updateMany.mockImplementation(async () => {
      order.push("claim");
      return { count: 1 };
    });
    tx.consulteeProfile.upsert.mockImplementation(async () => {
      order.push("profile");
      return { id: "cee_1" };
    });

    const result = await processOnboardingData(
      USER_ID,
      consulteeBody({ marketingConsent: true }),
    );

    expect(result.success).toBe(true);
    expect(order).toEqual(["claim", "profile"]);
    const claim = tx.user.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual({
      id: USER_ID,
      onboardingCompleted: { not: true },
    });
    expect(claim.data.onboardingCompleted).toBe(true);
    expect(claim.data.role).toBe("CONSULTEE");
    expect(claim.data.termsAcceptedAt).toBeInstanceOf(Date);
    expect(claim.data.privacyAcceptedAt).toBeInstanceOf(Date);
    expect(mockEnsureConsent).toHaveBeenCalledWith(
      tx,
      USER_ID,
      expect.arrayContaining(["PRIMARY_PROCESSING", "MARKETING_COMMS"]),
    );
  });

  it("refuses a payload without consent before opening a transaction", async () => {
    const result = await processOnboardingData(
      USER_ID,
      consulteeBody({ termsAccepted: undefined }),
    );
    expect(result).toMatchObject({
      success: false,
      code: "VALIDATION",
      field: "termsAccepted",
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("double submit: the second claim loses, writes no profile, and recovers as success", async () => {
    tx.user.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const [first, second] = await Promise.all([
      processOnboardingData(USER_ID, consulteeBody()),
      processOnboardingData(USER_ID, consulteeBody()),
    ]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(tx.consulteeProfile.upsert).toHaveBeenCalledTimes(1);
  });

  it("a lost claim for a different role is ALREADY_ONBOARDED, not silent success", async () => {
    tx.user.updateMany.mockResolvedValue({ count: 0 });
    mockFindUnique.mockImplementation(async (args: { select?: unknown }) =>
      args.select
        ? { id: USER_ID }
        : storedUser({ role: "CONSULTANT", consultantProfileId: "cp_1" }),
    );

    const result = await processOnboardingData(USER_ID, consulteeBody());

    expect(result).toMatchObject({ success: false, code: "ALREADY_ONBOARDED" });
    expect(tx.consulteeProfile.upsert).not.toHaveBeenCalled();
  });

  it("a lost claim whose role profile is missing is not reported as success", async () => {
    tx.user.updateMany.mockResolvedValue({ count: 0 });
    mockFindUnique.mockImplementation(async (args: { select?: unknown }) =>
      args.select
        ? { id: USER_ID }
        : storedUser({ role: "CONSULTANT", consultantProfileId: null }),
    );
    const result = await processOnboardingData(
      USER_ID,
      consulteeBody({ role: "CONSULTEE" }),
    );
    expect(result).toMatchObject({ success: false, code: "ALREADY_ONBOARDED" });
  });

  it("recovers a concurrent P2002 once the other request completed onboarding", async () => {
    tx.consulteeProfile.upsert.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["userId"] },
      }),
    );
    const result = await processOnboardingData(USER_ID, consulteeBody());
    expect(result.success).toBe(true);
  });

  it("maps a P2002 on User.phone to a refusal routed to the phone field", async () => {
    tx.user.updateMany.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["phone"] },
      }),
    );
    const result = await processOnboardingData(
      USER_ID,
      consulteeBody({ phone: "+910000000000" }),
    );
    expect(result).toMatchObject({
      success: false,
      code: "PHONE_TAKEN",
      field: "phone",
    });
  });

  it("refuses an invalid professional-background entry instead of dropping it", async () => {
    const result = await processOnboardingData(
      USER_ID,
      consulteeBody({ workExperiences: [{ company: "" }] }),
    );
    expect(result).toMatchObject({
      success: false,
      field: "workExperiences",
    });
  });
});
