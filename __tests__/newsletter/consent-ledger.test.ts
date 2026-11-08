/**
 * @jest-environment node
 */

/**
 * A confirmed sign-up writes one MARKETING_COMMS artifact (on the account when
 * the address has one, on a pseudonymous subject otherwise) in the same
 * transaction, a re-confirm reuses it, and an unsubscribe withdraws it.
 */

type Artifact = {
  userId?: string;
  subjectPseudonymousId?: string;
  purposeCodes: string[];
  version: number;
  withdrawnAt: Date | null;
  auditRetainedUntil: Date;
};
type Where = Partial<Record<"userId" | "subjectPseudonymousId", string>> & {
  withdrawnAt?: null;
};

const artifacts: Artifact[] = [];
const matches = (row: Artifact, where: Where) =>
  (where.userId === undefined || row.userId === where.userId) &&
  (where.subjectPseudonymousId === undefined ||
    row.subjectPseudonymousId === where.subjectPseudonymousId) &&
  (where.withdrawnAt !== null || row.withdrawnAt === null);

const mockSubscriberFind = jest.fn();
const mockSubscriberUpdate = jest.fn();
const mockUserFind = jest.fn();
const mockSubscriberLock = jest.fn();
const lockOrder: string[] = [];
const tx = {
  newsletterSubscriber: {
    findUnique: (...args: unknown[]) => mockSubscriberFind(...args),
    updateMany: (...args: unknown[]) => mockSubscriberUpdate(...args),
    updateManyAndReturn: (...args: unknown[]) => {
      lockOrder.push("subscriber");
      return mockSubscriberLock(...args);
    },
  },
  user: { findUnique: (...args: unknown[]) => mockUserFind(...args) },
  consentArtifact: {
    create: async ({ data }: { data: Artifact }) => {
      artifacts.push({ ...data, withdrawnAt: null });
    },
    findFirst: async ({ where }: { where: Where }) =>
      artifacts.find((row) => matches(row, where)) ?? null,
    findMany: async ({ where }: { where: Where }) =>
      artifacts.filter((row) => matches(row, where)),
    updateMany: async ({
      where,
      data,
    }: {
      where: Where;
      data: Partial<Artifact>;
    }) => {
      lockOrder.push("artifact");
      const hit = artifacts.filter((row) => matches(row, where));
      hit.forEach((row) => Object.assign(row, data));
      return { count: hit.length };
    },
  },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { $transaction: (fn: (t: unknown) => unknown) => fn(tx) },
}));
jest.mock("../../lib/email", () => ({
  sendNewsletterConfirmEmail: jest.fn(),
  sendNewsletterWelcomeEmail: jest.fn().mockResolvedValue({ success: true }),
}));
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../../lib/newsletter/tokens", () => ({
  verifyConfirmToken: () => true,
  verifyUnsubscribeToken: () => true,
}));

import { confirmSubscription, unsubscribe } from "../../lib/newsletter/service";
import { NEWSLETTER_NOTICE_VERSION } from "../../lib/newsletter/notice";

const confirm = () =>
  confirmSubscription({ email: "Reader@Example.com", token: "t", issuedAt: 1 });

describe("the newsletter writes and withdraws one consent ledger", () => {
  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = "test-auth-secret-at-least-32-chars";
    artifacts.length = 0;
    jest.clearAllMocks();
    mockSubscriberFind.mockResolvedValue({
      status: "PENDING",
      name: null,
      userId: null,
    });
    mockSubscriberUpdate.mockResolvedValue({ count: 1 });
    mockUserFind.mockResolvedValue(null);
  });

  it("records a pseudonymous artifact for an address with no account, once", async () => {
    await expect(confirm()).resolves.toEqual({ outcome: "CONFIRMED" });
    await confirm();

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      purposeCodes: ["MARKETING_COMMS"],
      version: NEWSLETTER_NOTICE_VERSION,
    });
    expect(artifacts[0].userId).toBeUndefined();
    expect(artifacts[0].subjectPseudonymousId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("links the matching account to the row and the artifact", async () => {
    mockUserFind.mockResolvedValue({ id: "user_1" });

    await confirm();

    expect(mockSubscriberUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SUBSCRIBED",
          userId: "user_1",
        }),
      }),
    );
    expect(artifacts).toEqual([expect.objectContaining({ userId: "user_1" })]);
  });

  it("ignores a stored account that does not own the confirmed address", async () => {
    mockSubscriberFind.mockResolvedValue({
      status: "PENDING",
      name: null,
      userId: "someone_else",
    });

    await confirm();

    expect(mockSubscriberUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: null }),
      }),
    );
    expect(artifacts[0].userId).toBeUndefined();
  });

  it("writes nothing for an address already subscribed", async () => {
    mockSubscriberFind.mockResolvedValue({ status: "SUBSCRIBED", name: null });

    await expect(confirm()).resolves.toEqual({ outcome: "ALREADY_CONFIRMED" });
    expect(mockSubscriberUpdate).not.toHaveBeenCalled();
    expect(artifacts).toHaveLength(0);
  });

  it("withdraws the artifact on unsubscribe, locking the subscriber row first", async () => {
    await confirm();
    mockSubscriberLock.mockResolvedValue([
      { userId: null, consentSubjectId: null },
    ]);
    lockOrder.length = 0;

    await expect(
      unsubscribe({ email: "reader@example.com", token: "t" }),
    ).resolves.toEqual({ ok: true });
    expect(artifacts[0].withdrawnAt).toBeInstanceOf(Date);
    expect(lockOrder[0]).toBe("subscriber");
    expect(lockOrder).toContain("artifact");
  });

  it("withdraws the stored subject after the auth secret rotates", async () => {
    await confirm();
    const stored = mockSubscriberUpdate.mock.calls[0][0].data.consentSubjectId;
    expect(stored).toBe(artifacts[0].subjectPseudonymousId);

    process.env.BETTER_AUTH_SECRET = "a-rotated-auth-secret-of-enough-length";
    mockSubscriberLock.mockResolvedValue([
      { userId: null, consentSubjectId: stored },
    ]);
    await unsubscribe({ email: "reader@example.com", token: "t" });

    expect(artifacts[0].withdrawnAt).toBeInstanceOf(Date);
  });
});
