/** @jest-environment node */
import type { Tx } from "../../lib/prisma";
import { txDouble } from "../fixtures/tx-double";
import { cleanupAuthTokens } from "../../lib/auth/cleanup-auth-tokens";
import {
  archiveWebhookEvents,
  WEBHOOK_DELETE_BATCH,
  webhookEventRetentionCutoff,
} from "../../scripts/cleanup/archive-webhook-events";
import { pruneAuditLogs } from "../../scripts/cleanup/prune-audit-logs";
import { expireOnboardingDrafts } from "../../scripts/cleanup/expire-onboarding-drafts";

jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (
    _name: string,
    _options: unknown,
    work: () => Promise<unknown>,
  ) => work(),
}));
jest.mock("../../lib/prisma", () => {
  const delegate = () => ({
    findMany: jest.fn(),
    findFirst: jest.fn(),
    deleteMany: jest.fn(),
    updateMany: jest.fn(),
    create: jest.fn(),
  });
  return {
    __esModule: true,
    default: {
      verification: delegate(),
      session: delegate(),
      sessionAccessLog: delegate(),
      idempotencyRecord: delegate(),
      invitation: delegate(),
      orgAuditLog: delegate(),
      onboardingDraft: delegate(),
      opsActionLog: delegate(),
      opsActionProposal: delegate(),
      bookingStatusHistory: delegate(),
      ledgerReconciliationReport: delegate(),
      referral: delegate(),
      payment: delegate(),
      $transaction: jest.fn(),
      $executeRaw: jest.fn(),
      $queryRaw: jest.fn(),
    },
  };
});

type Delegate = Record<
  "findMany" | "findFirst" | "deleteMany" | "updateMany" | "create",
  jest.Mock
>;
type Model =
  | "verification"
  | "session"
  | "sessionAccessLog"
  | "idempotencyRecord"
  | "invitation"
  | "orgAuditLog"
  | "onboardingDraft"
  | "opsActionLog"
  | "opsActionProposal"
  | "bookingStatusHistory"
  | "ledgerReconciliationReport"
  | "referral"
  | "payment";
const { default: db } = jest.requireMock<{
  default: Record<Model, Delegate> & {
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
    $queryRaw: jest.Mock;
  };
}>("../../lib/prisma");
const models: Model[] = [
  "verification",
  "session",
  "sessionAccessLog",
  "idempotencyRecord",
  "invitation",
  "orgAuditLog",
  "onboardingDraft",
  "opsActionLog",
  "opsActionProposal",
  "bookingStatusHistory",
  "ledgerReconciliationReport",
  "referral",
  "payment",
];
const NOW = new Date("2026-10-23T12:00:00Z");
const DAY = 86_400_000;

beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  for (const model of models) {
    db[model].findMany.mockResolvedValue([]);
    db[model].findFirst.mockResolvedValue(null);
    db[model].deleteMany.mockResolvedValue({ count: 0 });
  }
  db.$transaction.mockImplementation(
    async (work: (tx: Tx) => Promise<unknown>) =>
      work(
        txDouble({
          invitation: db.invitation,
          orgAuditLog: db.orgAuditLog,
          session: db.session,
          $executeRaw: db.$executeRaw,
          $queryRaw: db.$queryRaw,
        }),
      ),
  );
  db.$queryRaw.mockResolvedValue([{ ready: true }]);
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it.each(["verification", "idempotencyRecord"] as const)(
  "preserves a %s row refreshed between selection and deletion",
  async (model) => {
    let expiry = new Date(NOW.getTime() - DAY);
    db[model].findMany.mockImplementation(async () => {
      expiry = new Date(NOW.getTime() + DAY);
      return [{ id: "refreshed" }];
    });
    db[model].deleteMany.mockImplementation(
      async ({
        where,
      }: {
        where: { id: { in: string[] }; expiresAt: { lt: Date } };
      }) => ({
        count:
          where.id.in.includes("refreshed") && expiry < where.expiresAt.lt
            ? 1
            : 0,
      }),
    );
    const result = await cleanupAuthTokens();
    expect(result).toMatchObject({
      success: true,
      totalCleaned: 0,
      hasMore: false,
    });
    expect(db[model].deleteMany).toHaveBeenCalledWith({
      where: {
        expiresAt: { lt: NOW },
        id: { in: ["refreshed"] },
      },
    });
  },
);

const expiredSession = {
  id: "expired-session",
  userId: "u1",
  ipAddress: "203.0.113.7",
  userAgent: "Firefox",
  createdAt: new Date(NOW.getTime() - 31 * DAY),
  expiresAt: new Date(NOW.getTime() - DAY),
};

it("deletes expired sessions and stamps them EXPIRED in one transaction, which a failed stamp rolls back", async () => {
  db.session.findMany.mockResolvedValueOnce([expiredSession]);
  db.session.deleteMany.mockResolvedValue({ count: 1 });
  db.$executeRaw.mockResolvedValueOnce(1);
  expect(await cleanupAuthTokens()).toMatchObject({ sessionsDeleted: 1 });
  expect(db.$transaction).toHaveBeenCalled();
  expect(db.session.deleteMany).toHaveBeenCalledWith({
    where: { expiresAt: { lt: NOW }, id: { in: ["expired-session"] } },
  });
  expect(db.$executeRaw.mock.calls[0][1].values).toEqual(
    expect.arrayContaining([
      "expired-session",
      expiredSession.expiresAt,
      "EXPIRED",
    ]),
  );
  expect(db.$executeRaw.mock.calls[0][1].sql).not.toContain("FOR SHARE");

  db.session.findMany.mockResolvedValueOnce([expiredSession]);
  db.$executeRaw.mockRejectedValueOnce(new Error("relation is locked"));
  expect(await cleanupAuthTokens()).toMatchObject({
    success: false,
    sessionsDeleted: 0,
    hasMore: true,
  });
});

it("stamps only the sessions the delete removed, never one refreshed after the read", async () => {
  const refreshed = { ...expiredSession, id: "refreshed-session" };
  db.session.findMany
    .mockResolvedValueOnce([expiredSession, refreshed])
    .mockResolvedValueOnce([{ id: "refreshed-session" }]);
  db.session.deleteMany.mockResolvedValue({ count: 1 });
  db.$executeRaw.mockResolvedValueOnce(1);
  expect(await cleanupAuthTokens()).toMatchObject({ sessionsDeleted: 1 });
  expect(db.session.findMany).toHaveBeenLastCalledWith({
    where: { id: { in: ["expired-session", "refreshed-session"] } },
    select: { id: true },
  });
  const values = db.$executeRaw.mock.calls[0][1].values;
  expect(values).toContain("expired-session");
  expect(values).not.toContain("refreshed-session");
});

it("prunes access-log rows 180 days after their end, or after start plus a session length when never stamped", async () => {
  db.sessionAccessLog.findMany.mockResolvedValue([{ id: "old" }]);
  db.sessionAccessLog.deleteMany.mockResolvedValue({ count: 1 });
  expect(await cleanupAuthTokens()).toMatchObject({ accessLogsDeleted: 1 });
  expect(db.sessionAccessLog.deleteMany).toHaveBeenCalledWith({
    where: {
      OR: [
        { endedAt: { lt: new Date(NOW.getTime() - 180 * DAY) } },
        {
          endedAt: null,
          startedAt: { lt: new Date(NOW.getTime() - 210 * DAY) },
        },
      ],
      id: { in: ["old"] },
    },
  });
});

it("caps each auth arm and reports eligible rows remaining after the slice", async () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  db.verification.findMany.mockImplementation(
    async ({ take }: { take: number }) => rows.slice(0, take),
  );
  db.verification.deleteMany.mockResolvedValue({ count: 1 });
  db.verification.findFirst.mockResolvedValue({ id: "b" });
  const result = await cleanupAuthTokens({ limit: 1 });
  expect(result).toMatchObject({ verificationTokensDeleted: 1, hasMore: true });
  expect(db.verification.deleteMany.mock.calls[0][0].where.id.in).toEqual([
    "a",
  ]);
  expect(db.invitation.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ take: 1 }),
  );
});

it("shares the auth start budget across phases, including selection time", async () => {
  db.verification.findMany.mockImplementation(async () => {
    jest.setSystemTime(NOW.getTime() + 16_001);
    return [{ id: "late" }];
  });
  expect(await cleanupAuthTokens()).toMatchObject({
    success: true,
    hasMore: true,
    totalCleaned: 0,
  });
  expect(db.verification.deleteMany).not.toHaveBeenCalled();
  expect(db.session.findMany).not.toHaveBeenCalled();
  expect(db.invitation.findMany).not.toHaveBeenCalled();
});

it("isolates auth-arm failures and never calls the backlog drained", async () => {
  db.verification.findMany.mockRejectedValue(new Error("unavailable"));
  db.session.findMany.mockResolvedValue([expiredSession]);
  db.session.deleteMany.mockResolvedValue({ count: 1 });
  expect(await cleanupAuthTokens()).toMatchObject({
    success: false,
    sessionsDeleted: 1,
    hasMore: true,
  });
});

it("does not count an invitation expiry when its atomic audit write fails", async () => {
  db.invitation.findMany.mockResolvedValue([
    {
      id: "invite",
      organizationId: "org",
      email: "a@example.test",
      role: "LEARNER",
      expiresAt: new Date(NOW.getTime() - DAY),
    },
  ]);
  db.invitation.updateMany.mockResolvedValue({ count: 1 });
  db.orgAuditLog.create.mockRejectedValue(new Error("audit unavailable"));
  expect(await cleanupAuthTokens()).toMatchObject({
    success: false,
    staleInvitationsExpired: 0,
    hasMore: true,
  });
});

it("keeps a draft saved after its old version was selected", async () => {
  let updatedAt = new Date(NOW.getTime() - 91 * DAY);
  db.onboardingDraft.findMany.mockImplementation(async () => {
    updatedAt = NOW;
    return [{ id: "draft" }];
  });
  db.onboardingDraft.deleteMany.mockImplementation(
    async ({
      where,
    }: {
      where: { updatedAt: { lt: Date }; id: { in: string[] } };
    }) => ({
      count:
        where.id.in.includes("draft") && updatedAt < where.updatedAt.lt ? 1 : 0,
    }),
  );
  expect(await expireOnboardingDrafts()).toMatchObject({
    success: true,
    deleted: 0,
    hasMore: false,
  });
  expect(db.onboardingDraft.deleteMany).toHaveBeenCalledWith({
    where: {
      id: { in: ["draft"] },
      updatedAt: { lt: new Date(NOW.getTime() - 90 * DAY) },
    },
  });
});

it("does not start draft work after its request budget elapsed", async () => {
  expect(
    await expireOnboardingDrafts({ startedAt: NOW.getTime() - 16_000 }),
  ).toMatchObject({ deleted: 0, hasMore: true });
  expect(db.onboardingDraft.findMany).not.toHaveBeenCalled();
});

const sqlOf = (call: number): { sql: string; values: unknown[] } =>
  db.$executeRaw.mock.calls[call][0];

it("drains whole webhook batches, deliveries first, until a batch comes back short", async () => {
  for (const count of [WEBHOOK_DELETE_BATCH, 5, WEBHOOK_DELETE_BATCH, 7])
    db.$executeRaw.mockResolvedValueOnce(count);
  expect(await archiveWebhookEvents()).toMatchObject({
    success: true,
    outboundDeliveriesDeleted: WEBHOOK_DELETE_BATCH + 5,
    webhookEventsDeleted: WEBHOOK_DELETE_BATCH + 7,
    hasMore: false,
  });
  expect(db.$executeRaw).toHaveBeenCalledTimes(4);
  expect(sqlOf(0).sql).toContain('DELETE FROM "OutboundWebhookDelivery"');
  expect(sqlOf(0).values).toContainEqual(new Date(NOW.getTime() - 30 * DAY));
  expect(sqlOf(2).sql).toContain('("processed" OR "error" IS NOT NULL)');
  expect(sqlOf(2).values).toContainEqual(new Date("2025-10-23T12:00:00Z"));
  expect(webhookEventRetentionCutoff(new Date("2028-03-01T00:00:00Z"))).toEqual(
    new Date("2027-03-01T00:00:00Z"),
  );
});

it("keeps committed webhook deletes after a failure and starts no batch past the budget", async () => {
  db.$executeRaw
    .mockResolvedValueOnce(WEBHOOK_DELETE_BATCH)
    .mockRejectedValueOnce(new Error("lock timeout"))
    .mockImplementationOnce(async () => {
      jest.setSystemTime(NOW.getTime() + 17_000);
      return WEBHOOK_DELETE_BATCH;
    });
  expect(await archiveWebhookEvents()).toMatchObject({
    success: false,
    outboundDeliveriesDeleted: WEBHOOK_DELETE_BATCH,
    webhookEventsDeleted: WEBHOOK_DELETE_BATCH,
    hasMore: true,
  });
  expect(db.$executeRaw).toHaveBeenCalledTimes(3);
});

it("bounds the global audit cohort and commits each org's summary with its deletes", async () => {
  const rows = [
    { id: "a", organizationId: "org-a" },
    { id: "b", organizationId: "org-b" },
    { id: "tail", organizationId: "org-c" },
  ];
  db.orgAuditLog.findMany.mockImplementation(
    async ({ take }: { take: number }) => rows.slice(0, take),
  );
  db.orgAuditLog.deleteMany.mockImplementation(
    async ({
      where,
    }: {
      where: { category: { in: string[] }; id: { in: string[] } };
    }) => ({
      count: where.category.in.includes("INVOICE") ? where.id.in.length : 0,
    }),
  );
  db.orgAuditLog.findFirst.mockResolvedValue({ id: "tail" });
  const result = await pruneAuditLogs({ limit: 2 });
  expect(result).toMatchObject({
    success: true,
    scanned: 2,
    deleted8y: 2,
    deleted2y: 0,
    perOrgSummaries: 2,
    hasMore: true,
  });
  expect(db.$transaction).toHaveBeenCalledTimes(2);
  expect(db.orgAuditLog.deleteMany.mock.calls[0][0].where).toEqual({
    id: { in: ["a"] },
    organizationId: "org-a",
    category: { in: ["INVOICE", "PAYOUT", "WALLET", "CONTRACT", "CONSENT"] },
    createdAt: { lt: new Date("2018-10-23T12:00:00Z") },
  });
});

it("counts only committed audit summaries after a commit failure and continues another org", async () => {
  db.orgAuditLog.findMany.mockResolvedValue([
    { id: "bad", organizationId: "bad-org" },
    { id: "good", organizationId: "good-org" },
  ]);
  db.orgAuditLog.deleteMany.mockResolvedValue({ count: 1 });
  db.$transaction.mockImplementationOnce(
    async (work: (tx: Tx) => Promise<unknown>) => {
      await work(txDouble({ orgAuditLog: db.orgAuditLog }));
      throw new Error("commit failed");
    },
  );
  expect(await pruneAuditLogs()).toMatchObject({
    success: false,
    scanned: 2,
    deleted8y: 1,
    deleted2y: 1,
    perOrgSummaries: 1,
    hasMore: true,
  });
});

it("does not start audit transactions once selection exhausts the shared budget", async () => {
  db.orgAuditLog.findMany.mockImplementation(async () => {
    jest.setSystemTime(NOW.getTime() + 16_001);
    return [{ id: "audit", organizationId: "org" }];
  });
  expect(await pruneAuditLogs()).toMatchObject({
    success: true,
    scanned: 1,
    perOrgSummaries: 0,
    hasMore: true,
  });
  expect(db.$transaction).not.toHaveBeenCalled();
});

it("retains committed auth deletes when the continuation probe fails", async () => {
  db.verification.findMany.mockResolvedValue([{ id: "expired" }]);
  db.verification.deleteMany.mockResolvedValue({ count: 1 });
  db.verification.findFirst.mockRejectedValue(new Error("probe unavailable"));
  expect(await cleanupAuthTokens()).toMatchObject({
    success: false,
    verificationTokensDeleted: 1,
    totalCleaned: 1,
    hasMore: true,
    errors: [expect.stringContaining("probe unavailable")],
  });
});

it("keeps money-surface console actions eight years and the rest two", async () => {
  await pruneAuditLogs();
  const [money, other] = db.opsActionLog.findMany.mock.calls.map(
    ([args]) => args.where,
  );
  expect(money).toEqual({
    surface: { notIn: expect.not.arrayContaining(["refunds.manage"]) },
    createdAt: { lt: new Date("2018-10-23T12:00:00Z") },
  });
  expect(other.surface.in).toEqual(
    expect.arrayContaining(["systemJobs.manage", "users.read"]),
  );
  expect(other.surface.in).not.toContain("payments.manage");
  expect(other.createdAt).toEqual({
    lt: new Date("2024-10-23T12:00:00Z"),
  });
});

it("nulls referral request signals and payer hashes past their windows, one bounded page each, and reports the counts", async () => {
  db.referral.findMany.mockResolvedValue([{ id: "ref-1" }, { id: "ref-2" }]);
  db.referral.updateMany.mockResolvedValue({ count: 2 });
  db.payment.findMany.mockResolvedValue([{ id: "pay-1" }]);
  db.payment.updateMany.mockResolvedValue({ count: 1 });

  const result = await pruneAuditLogs({ limit: 50 });

  expect(result).toMatchObject({
    success: true,
    referralSignalsNulled: 2,
    payerSignalsNulled: 1,
  });
  expect(db.referral.findMany.mock.calls[0][0].take).toBe(50);
  expect(db.referral.updateMany.mock.calls[0][0]).toMatchObject({
    where: { AND: [expect.anything(), { id: { in: ["ref-1", "ref-2"] } }] },
    data: { ipHash: null, userAgent: null },
  });
  expect(db.payment.updateMany.mock.calls[0][0]).toMatchObject({
    where: { AND: [expect.anything(), { id: { in: ["pay-1"] } }] },
    data: { payerVpaHash: null, payerPhoneHash: null },
  });
  expect(db.payment.updateMany.mock.calls[0][0]).not.toHaveProperty(
    "data.paymentStatus",
  );
});

it("clears nothing and reports no failure when no signal is past its window", async () => {
  const result = await pruneAuditLogs();
  expect(result).toMatchObject({
    success: true,
    referralSignalsNulled: 0,
    payerSignalsNulled: 0,
  });
  expect(db.referral.updateMany).not.toHaveBeenCalled();
  expect(db.payment.updateMany).not.toHaveBeenCalled();
});
