/** @jest-environment node */
import type { Tx } from "../../lib/prisma";
import { txDouble } from "../fixtures/tx-double";
import { cleanupAuthTokens } from "../../lib/auth/cleanup-auth-tokens";
import { archiveWebhookEvents } from "../../scripts/cleanup/archive-webhook-events";
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
      idempotencyRecord: delegate(),
      invitation: delegate(),
      webhookEvent: delegate(),
      outboundWebhookDelivery: delegate(),
      orgAuditLog: delegate(),
      onboardingDraft: delegate(),
      $transaction: jest.fn(),
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
  | "idempotencyRecord"
  | "invitation"
  | "webhookEvent"
  | "outboundWebhookDelivery"
  | "orgAuditLog"
  | "onboardingDraft";
const { default: db } = jest.requireMock<{
  default: Record<Model, Delegate> & { $transaction: jest.Mock };
}>("../../lib/prisma");
const models: Model[] = [
  "verification",
  "session",
  "idempotencyRecord",
  "invitation",
  "webhookEvent",
  "outboundWebhookDelivery",
  "orgAuditLog",
  "onboardingDraft",
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
        txDouble({ invitation: db.invitation, orgAuditLog: db.orgAuditLog }),
      ),
  );
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it.each(["verification", "session", "idempotencyRecord"] as const)(
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
        id: { in: ["refreshed"] },
        expiresAt: { lt: NOW },
      },
    });
  },
);

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
  db.session.findMany.mockResolvedValue([{ id: "expired-session" }]);
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

it("rechecks webhook processing/error and terminal delivery state at deletion", async () => {
  db.webhookEvent.findMany.mockResolvedValueOnce([{ id: "processed" }]);
  db.outboundWebhookDelivery.findMany.mockResolvedValue([{ id: "redriven" }]);
  // Both rows change after selection: the event is retrying and delivery is RETRY.
  const event = { processed: false, error: "retry" };
  const deliveryStatus = "RETRY";
  db.webhookEvent.deleteMany.mockImplementation(
    async ({
      where,
    }: {
      where: { processed: boolean; error: null; receivedAt: { lt: Date } };
    }) => ({
      count:
        event.processed === where.processed && event.error === where.error
          ? 1
          : 0,
    }),
  );
  db.outboundWebhookDelivery.deleteMany.mockImplementation(
    async ({
      where,
    }: {
      where: { status: { in: string[] }; createdAt: { lt: Date } };
    }) => ({ count: where.status.in.includes(deliveryStatus) ? 1 : 0 }),
  );
  expect(await archiveWebhookEvents({ limit: 2 })).toMatchObject({
    success: true,
    totalDeleted: 0,
  });
  expect(db.webhookEvent.deleteMany).toHaveBeenCalledWith({
    where: {
      id: { in: ["processed"] },
      processed: true,
      error: null,
      receivedAt: { lt: new Date(NOW.getTime() - 30 * DAY) },
    },
  });
  expect(db.outboundWebhookDelivery.deleteMany).toHaveBeenCalledWith({
    where: {
      id: { in: ["redriven"] },
      status: { in: ["SUCCESS", "FAILED", "DEAD_LETTER"] },
      createdAt: { lt: new Date(NOW.getTime() - 30 * DAY) },
    },
  });
});

it("preserves webhook retention windows and bounds every archive arm", async () => {
  await archiveWebhookEvents();
  expect(db.webhookEvent.findMany).toHaveBeenCalledTimes(3);
  for (const [args] of db.webhookEvent.findMany.mock.calls)
    expect(args.take).toBe(100);
  expect(db.webhookEvent.findMany.mock.calls[2][0].where).toEqual({
    processed: false,
    error: { not: null },
    receivedAt: { lt: new Date(NOW.getTime() - 90 * DAY) },
  });
  expect(db.outboundWebhookDelivery.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ take: 100 }),
  );
});

it("preserves committed archive counts if the remaining-work read fails", async () => {
  db.webhookEvent.findMany.mockResolvedValueOnce([{ id: "done" }]);
  db.webhookEvent.deleteMany.mockResolvedValue({ count: 1 });
  db.webhookEvent.findFirst.mockRejectedValueOnce(new Error("peek failed"));
  expect(await archiveWebhookEvents()).toMatchObject({
    success: false,
    processedEventsDeleted: 1,
    totalDeleted: 1,
    hasMore: true,
  });
  expect(db.outboundWebhookDelivery.findMany).toHaveBeenCalled();
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
    deleted7y: 2,
    deleted2y: 0,
    perOrgSummaries: 2,
    hasMore: true,
  });
  expect(db.$transaction).toHaveBeenCalledTimes(2);
  expect(db.orgAuditLog.deleteMany.mock.calls[0][0].where).toEqual({
    id: { in: ["a"] },
    organizationId: "org-a",
    category: { in: ["INVOICE", "PAYOUT", "WALLET", "CONTRACT", "CONSENT"] },
    createdAt: { lt: new Date(NOW.getTime() - 7 * 365 * DAY) },
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
    deleted7y: 1,
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
