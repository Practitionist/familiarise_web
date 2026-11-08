/**
 * @jest-environment node
 */

const mockCaptureMessage = jest.fn();
const mockCaptureException = jest.fn();
const mockMetricsGauge = jest.fn();
const mockMetricsCount = jest.fn();
const mockPostOpsChat = jest.fn();
const mockNewsletterUnsubscribe = jest.fn();

jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));
jest.mock("@sentry/nextjs", () => ({
  ...jest.requireActual<typeof import("@sentry/core")>("@sentry/core"),
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  metrics: {
    gauge: (...args: unknown[]) => mockMetricsGauge(...args),
    count: (...args: unknown[]) => mockMetricsCount(...args),
  },
}));

jest.mock("../../lib/observability/ops-chat", () => ({
  postOpsChat: (...args: unknown[]) => mockPostOpsChat(...args),
}));

jest.mock("../../lib/newsletter/service", () => ({
  unsubscribe: (...args: unknown[]) => mockNewsletterUnsubscribe(...args),
}));

import { NextRequest } from "next/server";
import type { FailedEmail, FailedEmailBatch, Prisma } from "@prisma/client";
import type { CreateEmailResponse } from "resend";
import { stage, type RenderedEmail } from "@/lib/email/deliver";
import { idempotencyKeyFor } from "@/lib/email/idempotency";
import {
  buildEmailUnsubscribeUrl,
  listUnsubscribeHeaders,
  reconstructUnsubscribeHeaders,
} from "@/lib/email/unsubscribe";
import { buildUnsubscribeUrl } from "@/lib/newsletter/tokens";
import {
  runEmailRetryTick,
  type FailedEmailStore,
  type RelaySender,
} from "@/jobs/email/retry-failed-emails";
import {
  GET as getNewsletterUnsubscribe,
  POST as postNewsletterUnsubscribe,
} from "@/app/api/newsletter/unsubscribe/route";

const T0 = new Date("2026-10-11T12:00:00Z").getTime();

function makeFailedEmail(overrides: Partial<FailedEmail> = {}): FailedEmail {
  return {
    id: "fe-default",
    recipient: "user@example.com",
    fromAddress: "Familiarise Payments <payments@mail.familiarisenow.com>",
    replyTo: "support@familiarisenow.com",
    subject: "Payment Confirmed",
    htmlBody: "<p>Receipt</p>",
    textBody: "Receipt",
    emailType: "PAYMENT_SUCCESS",
    status: "PENDING",
    attempts: 0,
    nextRetryAt: new Date(T0),
    lastError: null,
    sentAt: null,
    resendId: null,
    entityRef: null,
    deliveryUserId: null,
    deliveryCategory: null,
    firstAttemptAt: null,
    createdAt: new Date(T0 - 60_000),
    updatedAt: new Date(T0 - 60_000),
    ...overrides,
  };
}

function makeFailedBatch(
  overrides: Partial<FailedEmailBatch> = {},
): FailedEmailBatch {
  return {
    id: "feb-default",
    idempotencyKey: "NEWSLETTER_BROADCAST/batch-1",
    emailType: "NEWSLETTER_BROADCAST",
    payload: [
      {
        from: "Familiarise <newsletter@news.familiarisenow.com>",
        to: "reader@example.com",
        subject: "Update",
        html: "<p>News</p>",
      },
    ],
    status: "PENDING",
    attempts: 0,
    nextRetryAt: new Date(T0),
    lastError: null,
    sentAt: null,
    firstAttemptAt: null,
    createdAt: new Date(T0 - 60_000),
    updatedAt: new Date(T0 - 60_000),
    ...overrides,
  };
}

/** The first-attempt CAS: writes only rows whose anchor is still unset. */
function stampWhereUnset<T extends { id: string; firstAttemptAt: Date | null }>(
  rows: T[],
  args: { where?: { id?: unknown }; data: { firstAttemptAt?: unknown } },
): { count: number } {
  const row = rows.find((r) => r.id === args.where?.id);
  if (!row || row.firstAttemptAt !== null) return { count: 0 };
  row.firstAttemptAt = args.data.firstAttemptAt as Date;
  return { count: 1 };
}

/** Mirrors the relay's SQL: a status-filtered write settles only an unsettled row. */
function writeMany<
  T extends { id: string; status: string; firstAttemptAt: Date | null },
>(
  rows: T[],
  args: {
    where?: { id?: unknown; status?: unknown };
    data: Record<string, unknown>;
  },
): { count: number } {
  if (!args.where?.status) return stampWhereUnset(rows, args);
  const idx = rows.findIndex((r) => r.id === args.where?.id);
  if (idx < 0) return { count: 0 };
  if (rows[idx].status !== "PENDING" && rows[idx].status !== "RETRY") {
    return { count: 0 };
  }
  rows[idx] = { ...rows[idx], ...(args.data as Partial<T>) };
  return { count: 1 };
}

function isRowDue(
  row: { status: string; nextRetryAt: Date | null },
  nowDate: Date,
): boolean {
  if (row.status === "PENDING") {
    return (
      row.nextRetryAt === null || row.nextRetryAt.getTime() <= nowDate.getTime()
    );
  }
  if (row.status === "RETRY") {
    return (
      row.nextRetryAt !== null && row.nextRetryAt.getTime() <= nowDate.getTime()
    );
  }
  return false;
}

function createStatefulOutboxStore(initial: {
  emails?: FailedEmail[];
  batches?: FailedEmailBatch[];
}): {
  store: FailedEmailStore;
  emails: FailedEmail[];
  batches: FailedEmailBatch[];
} {
  const emails = [...(initial.emails ?? [])];
  const batches = [...(initial.batches ?? [])];

  const store: FailedEmailStore = {
    user: { findUnique: jest.fn().mockResolvedValue(null) },
    failedEmail: {
      findMany: jest.fn(async (args: Prisma.FailedEmailFindManyArgs) => {
        const whereJson = JSON.stringify(args.where);
        const lteMatch = /"lte":"([^"]+)"/.exec(whereJson);
        const nowDate = lteMatch ? new Date(lteMatch[1]) : new Date(T0);
        return emails.filter((row) => isRowDue(row, nowDate));
      }),
      updateMany: jest.fn(async (args: Prisma.FailedEmailUpdateManyArgs) =>
        writeMany(emails, args),
      ),
      count: jest.fn(
        async () =>
          emails.filter((r) => r.status === "PENDING" || r.status === "RETRY")
            .length,
      ),
    },
    emailSuppression: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    failedEmailBatch: {
      findMany: jest.fn(async (args: Prisma.FailedEmailBatchFindManyArgs) => {
        const whereJson = JSON.stringify(args.where);
        const lteMatch = /"lte":"([^"]+)"/.exec(whereJson);
        const nowDate = lteMatch ? new Date(lteMatch[1]) : new Date(T0);
        return batches.filter((row) => isRowDue(row, nowDate));
      }),
      updateMany: jest.fn(async (args: Prisma.FailedEmailBatchUpdateManyArgs) =>
        writeMany(batches, args),
      ),
    },
  };

  return { store, emails, batches };
}

function makeRelaySender(
  sendImpl: (
    payload: unknown,
    options: unknown,
  ) => Promise<CreateEmailResponse> = async () => ({
    data: { id: "re-sent-1" },
    error: null,
    headers: null,
  }),
  batchImpl: jest.Mock = jest.fn().mockResolvedValue({
    data: { data: [{ id: "re-batch-1" }] },
    error: null,
    headers: null,
  }),
): RelaySender & { send: jest.Mock; batchSend: jest.Mock } {
  const send = jest.fn(sendImpl);
  return {
    send,
    batchSend: batchImpl,
    emails: { send },
    batch: { send: batchImpl } as unknown as RelaySender["batch"],
  };
}

const OLD_SECRET = process.env.BETTER_AUTH_SECRET;
const OLD_DELIVERY_MODE = process.env.EMAIL_DELIVERY_MODE;

beforeEach(() => {
  process.env.BETTER_AUTH_SECRET = "test-auth-secret-at-least-32-chars-long";
  process.env.EMAIL_DELIVERY_MODE = "live";
  jest.clearAllMocks();
});

afterEach(() => {
  if (OLD_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = OLD_SECRET;

  if (OLD_DELIVERY_MODE === undefined) delete process.env.EMAIL_DELIVERY_MODE;
  else process.env.EMAIL_DELIVERY_MODE = OLD_DELIVERY_MODE;
});

describe("1. Inline lease protection on FailedEmail & FailedEmailBatch", () => {
  it("skips PENDING rows whose nextRetryAt is in the future (60s inline lease) and drains them once nextRetryAt <= now", async () => {
    const leaseExpiry = new Date(T0 + 60_000);
    const { store, emails, batches } = createStatefulOutboxStore({
      emails: [
        makeFailedEmail({
          id: "fe-leased",
          status: "PENDING",
          nextRetryAt: leaseExpiry,
        }),
      ],
      batches: [
        makeFailedBatch({
          id: "feb-leased",
          status: "PENDING",
          nextRetryAt: leaseExpiry,
        }),
      ],
    });
    const sender = makeRelaySender();

    // Tick at T0 + 15s (still within the 60s inline lease grace window)
    const earlyTick = await runEmailRetryTick({
      prisma: store,
      resend: sender,
      now: () => T0 + 15_000,
    });

    expect(earlyTick).toMatchObject({
      scanned: 0,
      sent: 0,
      batchesScanned: 0,
      batchesSent: 0,
    });
    expect(sender.send).not.toHaveBeenCalled();
    expect(sender.batchSend).not.toHaveBeenCalled();
    expect(emails[0].status).toBe("PENDING");
    expect(batches[0].status).toBe("PENDING");

    // Tick at T0 + 60s (lease expired: nextRetryAt <= now)
    const dueTick = await runEmailRetryTick({
      prisma: store,
      resend: sender,
      now: () => T0 + 60_000,
    });

    expect(dueTick).toMatchObject({
      scanned: 1,
      sent: 1,
      batchesScanned: 1,
      batchesSent: 1,
    });
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.batchSend).toHaveBeenCalledTimes(1);
    expect(emails[0].status).toBe("SENT");
    expect(batches[0].status).toBe("SENT");
  });
});

describe("2. Row-scoped Idempotency-Key (<EMAIL_TYPE>/failed-email/<row.id>)", () => {
  it("passes row.id in both stage() and runEmailRetryTick so repeat identical emails within 24h never collide", async () => {
    const identicalMsg: RenderedEmail = {
      from: "Familiarise Payments <payments@mail.familiarisenow.com>",
      to: "repeat@example.com",
      subject: "Payment Confirmed",
      html: "<p>Identical receipt</p>",
      text: "Identical receipt",
    };

    let seq = 0;
    const tx = {
      failedEmail: {
        create: jest.fn().mockImplementation(async () => {
          seq += 1;
          return { id: `row-${seq}` };
        }),
      },
      emailSuppression: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    } as never;

    const firstStaged = await stage(identicalMsg, "PAYMENT_SUCCESS", { tx });
    const secondStaged = await stage(identicalMsg, "PAYMENT_SUCCESS", { tx });

    expect(firstStaged?.idempotencyKey).toBe(
      "PAYMENT_SUCCESS/failed-email/row-1",
    );
    expect(secondStaged?.idempotencyKey).toBe(
      "PAYMENT_SUCCESS/failed-email/row-2",
    );
    expect(firstStaged?.idempotencyKey).not.toBe(secondStaged?.idempotencyKey);

    const { store } = createStatefulOutboxStore({
      emails: [
        makeFailedEmail({
          id: "row-1",
          recipient: identicalMsg.to,
          subject: identicalMsg.subject,
          htmlBody: identicalMsg.html,
          emailType: "PAYMENT_SUCCESS",
          nextRetryAt: new Date(T0),
        }),
        makeFailedEmail({
          id: "row-2",
          recipient: identicalMsg.to,
          subject: identicalMsg.subject,
          htmlBody: identicalMsg.html,
          emailType: "PAYMENT_SUCCESS",
          nextRetryAt: new Date(T0),
        }),
      ],
    });
    const sender = makeRelaySender();

    const tick = await runEmailRetryTick({
      prisma: store,
      resend: sender,
      now: () => T0,
    });

    expect(tick.sent).toBe(2);
    expect(sender.send.mock.calls[0][1]).toMatchObject({
      idempotencyKey: idempotencyKeyFor(
        identicalMsg,
        "PAYMENT_SUCCESS",
        "row-1",
      ),
    });
    expect(sender.send.mock.calls[1][1]).toMatchObject({
      idempotencyKey: idempotencyKeyFor(
        identicalMsg,
        "PAYMENT_SUCCESS",
        "row-2",
      ),
    });
    expect(sender.send.mock.calls[0][1].idempotencyKey).toBe(
      firstStaged?.idempotencyKey,
    );
    expect(sender.send.mock.calls[1][1].idempotencyKey).toBe(
      secondStaged?.idempotencyKey,
    );
  });
});

describe("3. Stateless RFC 8058 unsubscribe header reconstruction", () => {
  it("reconstructs List-Unsubscribe + List-Unsubscribe-Post for lifecycle and newsletter emails, and returns undefined for required notices", async () => {
    const lifecycleUrl = buildEmailUnsubscribeUrl("user_lifecycle_99");
    const lifecycleHeaders = reconstructUnsubscribeHeaders({
      recipient: "member@example.com",
      htmlBody: `<p>Booked! <a href="${lifecycleUrl}">Unsubscribe</a></p>`,
      textBody: `Booked! Unsubscribe: ${lifecycleUrl}`,
    });
    expect(lifecycleHeaders).toEqual(listUnsubscribeHeaders(lifecycleUrl));
    expect(lifecycleHeaders).toEqual({
      "List-Unsubscribe": `<${lifecycleUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });

    const newsletterUrl = buildUnsubscribeUrl("newsletter-sub@example.com");
    const newsletterHeaders = reconstructUnsubscribeHeaders({
      recipient: "newsletter-sub@example.com",
      htmlBody: `<p>Newsletter <a href="${newsletterUrl}">Unsubscribe</a></p>`,
      textBody: null,
    });
    expect(newsletterHeaders).toEqual(listUnsubscribeHeaders(newsletterUrl));

    // Mandatory account notice (category === null) has no unsubscribe link
    const requiredNoticeHeaders = reconstructUnsubscribeHeaders({
      recipient: "suspended@example.com",
      htmlBody: "<p>Your account has been suspended for policy violations.</p>",
      textBody: "Your account has been suspended for policy violations.",
    });
    expect(requiredNoticeHeaders).toBeUndefined();

    // Verify runEmailRetryTick injects reconstructed headers into resend.emails.send
    const { store } = createStatefulOutboxStore({
      emails: [
        makeFailedEmail({
          id: "fe-lifecycle",
          recipient: "member@example.com",
          htmlBody: `<p>Booked! <a href="${lifecycleUrl}">Unsubscribe</a></p>`,
          textBody: null,
          emailType: "APPOINTMENT_BOOKED",
        }),
      ],
    });
    const sender = makeRelaySender();
    await runEmailRetryTick({ prisma: store, resend: sender, now: () => T0 });

    expect(sender.send).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: {
          "List-Unsubscribe": `<${lifecycleUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
      expect.anything(),
    );
  });
});

describe("4. GET vs POST /api/newsletter/unsubscribe link-scanner safety", () => {
  it("renders confirmation HTML on GET without mutating DB, while POST performs immediate one-click unsubscribe", async () => {
    const getRes = await getNewsletterUnsubscribe(
      new NextRequest(
        "https://familiarisenow.com/api/newsletter/unsubscribe?email=sub%40example.com&token=tok_xyz",
        { method: "GET" },
      ),
    );
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-type")).toContain("text/html");
    const html = await getRes.text();
    expect(html).toContain("Confirm unsubscribe");
    expect(html).toContain('<form method="post"');
    expect(mockNewsletterUnsubscribe).not.toHaveBeenCalled();

    // Incomplete link on GET returns 400 HTML and also does not touch DB
    const badGetRes = await getNewsletterUnsubscribe(
      new NextRequest("https://familiarisenow.com/api/newsletter/unsubscribe", {
        method: "GET",
      }),
    );
    expect(badGetRes.status).toBe(400);
    expect(mockNewsletterUnsubscribe).not.toHaveBeenCalled();

    // RFC 8058 one-click POST immediately unsubscribes
    mockNewsletterUnsubscribe.mockResolvedValue({ ok: true });
    const postRes = await postNewsletterUnsubscribe(
      new NextRequest(
        "https://familiarisenow.com/api/newsletter/unsubscribe?email=sub%40example.com&token=tok_xyz",
        { method: "POST" },
      ),
    );
    expect(postRes.status).toBe(200);
    expect(await postRes.json()).toEqual({ success: true });
    expect(mockNewsletterUnsubscribe).toHaveBeenCalledTimes(1);
    expect(mockNewsletterUnsubscribe).toHaveBeenCalledWith({
      email: "sub@example.com",
      token: "tok_xyz",
    });
  });

  it("never answers unsubscribed when the write failed", async () => {
    mockNewsletterUnsubscribe.mockRejectedValueOnce(new Error("db down"));
    const res = await postNewsletterUnsubscribe(
      new NextRequest(
        "https://familiarisenow.com/api/newsletter/unsubscribe?email=sub%40example.com&token=tok_xyz",
        { method: "POST", headers: { accept: "text/html" } },
      ),
    );
    expect(res.status).toBe(500);
    const page = await res.text();
    expect(page).toContain("We could not unsubscribe you");
    expect(page).not.toContain("You are unsubscribed");
  });
});

describe("5. Per-tick Sentry dead-letter aggregation, metrics gauge & Ops Chat alert", () => {
  it("emits 0 per-row loop Sentry.captureMessage calls, deduplicates alerts per tick, updates email.outbox.dead_letter gauge, and posts to Ops Chat", async () => {
    let captureCallsDuringRowLoop = 0;

    const { store } = createStatefulOutboxStore({
      emails: [
        makeFailedEmail({
          id: "fe-dlq-1",
          emailType: "PAYMENT_SUCCESS",
          status: "RETRY",
          attempts: 4,
        }),
        makeFailedEmail({
          id: "fe-dlq-2",
          emailType: "PAYMENT_SUCCESS",
          status: "RETRY",
          attempts: 4,
        }),
        makeFailedEmail({
          id: "fe-dlq-3",
          emailType: "PAYMENT_SUCCESS",
          status: "RETRY",
          attempts: 4,
        }),
      ],
      batches: [
        makeFailedBatch({
          id: "feb-dlq-1",
          emailType: "NEWSLETTER_BROADCAST",
          status: "PENDING",
          attempts: 0,
        }),
      ],
    });

    const sender = makeRelaySender(
      async () => {
        captureCallsDuringRowLoop = mockCaptureMessage.mock.calls.length;
        throw new Error("Upstream 502 Bad Gateway");
      },
      jest.fn().mockImplementation(async () => {
        captureCallsDuringRowLoop = mockCaptureMessage.mock.calls.length;
        return {
          data: null,
          error: {
            name: "validation_error",
            message: "API key is invalid",
            statusCode: 401,
          },
          headers: null,
        };
      }),
    );

    const result = await runEmailRetryTick({
      prisma: store,
      resend: sender,
      now: () => T0,
    });

    expect(captureCallsDuringRowLoop).toBe(0);
    expect(result.deadLettered).toBe(3);
    expect(result.batchesDeadLettered).toBe(1);

    // 3 exhausted PAYMENT_SUCCESS rows collapse into 1 alert + 1 terminal alert = 2 total (not 4)
    expect(mockCaptureMessage).toHaveBeenCalledTimes(2);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining(
        "email retry exhausted 5 attempts (PAYMENT_SUCCESS)",
      ),
      expect.objectContaining({
        level: "error",
        tags: expect.objectContaining({ outbox_dead_letter: "true" }),
      }),
    );
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining("email retry hit a terminal error"),
      expect.objectContaining({
        level: "error",
        tags: expect.objectContaining({ outbox_dead_letter: "true" }),
      }),
    );

    expect(mockMetricsGauge).toHaveBeenCalledWith(
      "email.outbox.dead_letter",
      4,
    );
    expect(mockPostOpsChat).toHaveBeenCalledTimes(1);
    expect(mockPostOpsChat).toHaveBeenCalledWith(
      expect.stringContaining(
        "4 email(s)/batch(es) dead-lettered (rows=3, batches=1)",
      ),
    );
  });
});
