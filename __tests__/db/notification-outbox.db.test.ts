/**
 * Notification outbox semantics the unit stubs only imitate, against real
 * Postgres:
 *  - the SQL audience filter (`bellAudience`) and the per-recipient JS rule
 *    agree on every switch, category and missing relation, operators included;
 *  - fan-out pages stage once per key (`createManyAndReturn` skip-duplicates);
 *  - a definitive partial bell response keeps the retryable remainder on the
 *    row and moves terminal refusals to one DEAD_LETTER sibling;
 *  - neither relay overwrites a row another attempt already settled;
 *  - a Novu step failure found twice leaves one dead-letter sibling.
 */
import { randomUUID } from "node:crypto";

const mockTrigger = jest.fn();
const mockTriggerBulk = jest.fn();
jest.mock("../../lib/novu/client", () => ({
  __esModule: true,
  isNovuConfigured: () => true,
  getNovuClient: () => ({
    trigger: (...args: unknown[]) => mockTrigger(...args),
    triggerBulk: (...args: unknown[]) => mockTriggerBulk(...args),
  }),
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  ...jest.requireActual("../../lib/cron/with-cron-lock"),
  withCronLock: (_job: string, _opts: unknown, fn: () => unknown) => fn(),
}));

import type { Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";
import { NOVU_WORKFLOWS } from "../../lib/novu/workflows";
import { bellAudience, currentBellRecipients } from "../../lib/novu/policy";
import {
  attemptTrigger,
  recipientTransactionId,
  stagePages,
  type StagedTrigger,
} from "../../lib/novu/outbox";
import { probeNovuStepFailures } from "../../jobs/notifications/novu-step-failure-probe";
import {
  runEmailRetryTick,
  type FailedEmailStore,
  type RelaySender,
} from "../../jobs/email/retry-failed-emails";

type Prefs = Partial<
  Pick<
    Prisma.NotificationPreferenceCreateWithoutUserInput,
    | "allNotifications"
    | "inAppEnabled"
    | "appointmentReminders"
    | "paymentNotifications"
  >
>;

async function seedUser(opts: {
  prefs?: Prefs | null;
  operator?: boolean;
  erased?: boolean;
}): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Outbox Tier",
      email: `${randomUUID()}@example.test`,
      emailVerified: true,
      erasedAt: opts.erased ? new Date() : null,
      ...(opts.prefs
        ? { notificationPreferences: { create: opts.prefs } }
        : {}),
      ...(opts.operator ? { orgWorkspaceProfile: { create: {} } } : {}),
    },
    select: { id: true },
  });
  return user.id;
}

describe("bell audience: SQL filter matches the per-recipient rule", () => {
  const ids: string[] = [];

  beforeAll(async () => {
    const shapes: Parameters<typeof seedUser>[0][] = [
      { prefs: null },
      { prefs: {} },
      { prefs: { allNotifications: false } },
      { prefs: { inAppEnabled: false } },
      { prefs: { appointmentReminders: false } },
      { prefs: { paymentNotifications: false } },
      { erased: true },
      { operator: true },
      { operator: true, prefs: { inAppEnabled: false } },
    ];
    for (const shape of shapes) ids.push(await seedUser(shape));
  });

  it.each([
    ["no category", NOVU_WORKFLOWS.GENERAL_ANNOUNCEMENT],
    ["appointments", NOVU_WORKFLOWS.APPOINTMENT_BOOKED],
    ["payments", NOVU_WORKFLOWS.PAYMENT_LINK],
    ["orgBilling", NOVU_WORKFLOWS.ORG_INVOICE_ISSUED],
    ["required", NOVU_WORKFLOWS.ACCOUNT_SECURITY_NOTICE],
  ])("%s", async (_label, workflowId) => {
    const seeded = new Set(ids);
    const sql = (await bellAudience(prisma, workflowId, 1_000_000)) ?? [];
    const js = await currentBellRecipients(workflowId, ids);

    expect(sql.filter((id) => seeded.has(id)).sort()).toEqual(js.sort());
  });
});

describe("fan-out pages", () => {
  it("stage once per key, 100 recipients per page", async () => {
    const recipients = Array.from({ length: 250 }, () => randomUUID());
    const key = `announcement:${randomUUID()}`;
    const stage = () =>
      stagePages(prisma, {
        workflowId: NOVU_WORKFLOWS.GENERAL_ANNOUNCEMENT,
        recipients,
        payload: { title: "t", content: "c" },
        dedupeKey: key,
        entityRef: key,
      });

    const first = await stage();
    const second = await stage();

    expect(first.map((row) => row.recipients.length)).toEqual([100, 100, 50]);
    expect(second).toEqual([]);
    await expect(
      prisma.notificationOutbox.count({ where: { entityRef: key } }),
    ).resolves.toBe(3);
  });
});

async function stageMulti(recipients: string[]): Promise<StagedTrigger> {
  const key = `announcement:${randomUUID()}`;
  const [row] = await stagePages(prisma, {
    workflowId: NOVU_WORKFLOWS.GENERAL_ANNOUNCEMENT,
    recipients,
    payload: { title: "t", content: "c" },
    dedupeKey: key,
    entityRef: key,
  });
  return row;
}

describe("bell relay settles", () => {
  beforeEach(() => {
    mockTrigger.mockReset();
    mockTriggerBulk.mockReset();
  });

  it("splits a definitive partial response into the remainder and one terminal sibling", async () => {
    const [accepted, refused, retry] = [
      await seedUser({}),
      await seedUser({}),
      await seedUser({}),
    ];
    const row = await stageMulti([accepted, refused, retry]);
    const tx = (to: string) =>
      recipientTransactionId(row.transactionId || row.id, to);
    mockTriggerBulk.mockResolvedValue({
      result: [
        { status: "processed", transactionId: tx(accepted) },
        { status: "invalid_recipients", transactionId: tx(refused) },
        { status: "error", error: ["busy"], transactionId: tx(retry) },
      ],
    });

    await attemptTrigger(row, { relay: true, suppressSentry: true });

    const parent = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(parent.status).toBe("RETRY");
    expect(parent.recipients).toEqual([retry]);
    expect(parent.firstAttemptAt).toBeNull();
    const siblings = await prisma.notificationOutbox.findMany({
      where: {
        transactionId: { startsWith: `${row.transactionId}:terminal:` },
      },
    });
    expect(siblings).toHaveLength(1);
    expect(siblings[0]).toMatchObject({
      status: "DEAD_LETTER",
      recipients: [refused],
    });
  });

  it("never overwrites a row another attempt settled while the send was in flight", async () => {
    const row = await stageMulti([await seedUser({}), await seedUser({})]);
    mockTriggerBulk.mockImplementation(async () => {
      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: { status: "SENT" },
      });
      throw Object.assign(new Error("Novu 503"), { statusCode: 503 });
    });

    await attemptTrigger(row, { relay: true, suppressSentry: true });

    const after = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { id: row.id },
      select: { status: true },
    });
    expect(after.status).toBe("SENT");
  });
});

describe("Novu step failure probe", () => {
  it("records one dead-letter sibling however often the failure is read", async () => {
    const [ok, failed] = [await seedUser({}), await seedUser({})];
    const row = await stageMulti([ok, failed]);
    await prisma.notificationOutbox.update({
      where: { id: row.id },
      data: { status: "SENT", recipients: [] },
    });
    const activity = {
      hasMore: false,
      data: [
        {
          transactionId: recipientTransactionId(row.transactionId, failed),
          subscriber: { subscriberId: failed },
          jobs: [{ type: "in_app", status: "failed", executionDetails: [] }],
        },
      ],
    };
    const fetchPage = async () => Response.json(activity);
    process.env.NOVU_DEVELOPMENT_KEY = "test-key";

    const first = await probeNovuStepFailures({ db: prisma, fetchPage });
    const second = await probeNovuStepFailures({ db: prisma, fetchPage });

    expect([first.inserted, second.inserted]).toEqual([1, 0]);
    const siblings = await prisma.notificationOutbox.findMany({
      where: {
        transactionId: { startsWith: `${row.transactionId}:stepfailed:` },
      },
    });
    expect(siblings).toHaveLength(1);
    expect(siblings[0]).toMatchObject({
      kind: "SINGLE",
      status: "DEAD_LETTER",
      recipients: [failed],
      entityRef: row.entityRef,
      lastError: expect.stringMatching(/^review:novu_step_failed: /),
    });
    await expect(
      prisma.notificationOutbox.findUniqueOrThrow({ where: { id: row.id } }),
    ).resolves.toMatchObject({ status: "SENT" });
  });
});

describe("email relay settles", () => {
  it("never overwrites a row the inline attempt marked SENT mid-send", async () => {
    const entityRef = `db-tier:${randomUUID()}`;
    const { id } = await prisma.failedEmail.create({
      data: {
        recipient: `${randomUUID()}@example.test`,
        subject: "Race",
        htmlBody: "<p>hi</p>",
        emailType: "DB_TIER_TEST",
        status: "PENDING",
        nextRetryAt: null,
        entityRef,
      },
      select: { id: true },
    });
    const store: FailedEmailStore = {
      user: prisma.user,
      emailSuppression: prisma.emailSuppression,
      failedEmail: {
        findMany: (args) =>
          prisma.failedEmail.findMany({
            ...args,
            where: { AND: [args.where ?? {}, { entityRef }] },
          }),
        updateMany: (args) => prisma.failedEmail.updateMany(args),
      },
      failedEmailBatch: {
        findMany: async () => [],
        updateMany: (args) => prisma.failedEmailBatch.updateMany(args),
      },
    };
    const send = jest.fn(async () => {
      await prisma.failedEmail.update({
        where: { id },
        data: { status: "SENT", sentAt: new Date() },
      });
      throw new Error("Resend 503");
    });
    const resend = {
      emails: { send },
      batch: { send: jest.fn() },
    } as unknown as RelaySender;

    const result = await runEmailRetryTick({ prisma: store, resend });

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.retried).toBe(0);
    const after = await prisma.failedEmail.findUniqueOrThrow({
      where: { id },
      select: { status: true, lastError: true },
    });
    expect(after).toEqual({ status: "SENT", lastError: null });
  });
});
