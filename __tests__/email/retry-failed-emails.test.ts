/**
 * @jest-environment node
 */

/**
 * #474 — `runEmailRetryTick` replays dead-lettered transactional emails, so
 * its backoff / status semantics are the contract for "did the email
 * eventually go out". The tests pin:
 *
 *   - success → status=SENT with sentAt, no nextRetryAt churn.
 *   - re-send failure → status=RETRY with the NEXT backoff slot.
 *   - the full 1m/5m/30m/2h backoff walk (BACKOFF_MS), then DEAD_LETTER once
 *     attempt 5 is exhausted (operator-replayable; verbatim message preserved).
 *   - the stored fields are replayed verbatim (no re-render, no dispatcher),
 *     falling back to the app default `from` only when fromAddress is null.
 *   - #1298: the replay carries the content-derived idempotency key, a
 *     terminal error dead-letters on attempt 1, and an expired verification
 *     row is dead-lettered without a send.
 */

const mockCaptureMessage = jest.fn();
const mockPostOpsChat = jest.fn();
jest.mock("@/lib/observability/ops-chat", () => ({
  postOpsChat: (...args: unknown[]) => mockPostOpsChat(...args),
}));
jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));
jest.mock("@sentry/nextjs", () => ({
  ...jest.requireActual<typeof import("@sentry/core")>("@sentry/core"),
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
}));

import {
  runEmailRetryTick,
  BACKOFF_MS,
  SEND_GAP_MS,
  type FailedEmailStore,
  type RelaySender,
} from "@/jobs/email/retry-failed-emails";
import { idempotencyKeyFor } from "@/lib/email/idempotency";
import type {
  EmailSuppression,
  FailedEmail,
  FailedEmailBatch,
  Prisma,
} from "@prisma/client";
import type { CreateEmailResponse } from "resend";

function makeRow(overrides: Partial<FailedEmail> = {}): FailedEmail {
  return {
    id: "fe-1",
    recipient: "user@example.com",
    fromAddress: "Familiarise Payments <payments@mail.familiarisenow.com>",
    replyTo: null,
    subject: "Payment Confirmed",
    htmlBody: "<p>Thanks</p>",
    textBody: null,
    emailType: "PAYMENT_SUCCESS",
    status: "PENDING",
    attempts: 0,
    nextRetryAt: new Date("2026-06-16T11:59:00Z"),
    lastError: "rate limited",
    sentAt: null,
    // #1654 — the outbox columns; a replayed dead-letter row has neither yet.
    resendId: null,
    entityRef: null,
    deliveryUserId: null,
    deliveryCategory: null,
    firstAttemptAt: null,
    createdAt: new Date("2026-06-16T11:58:00Z"),
    updatedAt: new Date("2026-06-16T11:58:00Z"),
    ...overrides,
  };
}

function makeBatchRow(
  overrides: Partial<FailedEmailBatch> = {},
): FailedEmailBatch {
  return {
    id: "feb-1",
    idempotencyKey: "NEWSLETTER_BROADCAST/abc",
    emailType: "NEWSLETTER_BROADCAST",
    payload: [{ from: "a@x", to: "b@y", subject: "s", html: "<p/>" }],
    status: "PENDING",
    attempts: 0,
    nextRetryAt: null,
    lastError: null,
    sentAt: null,
    firstAttemptAt: null,
    createdAt: new Date("2026-06-16T11:58:00Z"),
    updatedAt: new Date("2026-06-16T11:58:00Z"),
    ...overrides,
  };
}

// #1647 — the store grew a suppression read and the batch outbox; both are
// empty unless a test hands them rows.
function makePrismaStub(
  initialRow: FailedEmail,
  extra: {
    suppressions?: Pick<EmailSuppression, "email" | "reason">[];
    batches?: FailedEmailBatch[];
  } = {},
) {
  // A write filtered on status is a settle; an unfiltered one is an anchor stamp.
  const updates: Prisma.FailedEmailUpdateManyArgs[] = [];
  const batchUpdates: Prisma.FailedEmailBatchUpdateManyArgs[] = [];
  const stamps: Prisma.FailedEmailUpdateManyArgs[] = [];
  const batchStamps: Prisma.FailedEmailBatchUpdateManyArgs[] = [];
  const suppressions = extra.suppressions ?? [];
  const prisma: FailedEmailStore = {
    user: { findUnique: jest.fn().mockResolvedValue(null) },
    failedEmail: {
      findMany: jest.fn().mockResolvedValue([initialRow]),
      updateMany: jest
        .fn()
        .mockImplementation((args: Prisma.FailedEmailUpdateManyArgs) => {
          (args.where?.status ? updates : stamps).push(args);
          return Promise.resolve({ count: 1 });
        }),
    },
    emailSuppression: {
      findMany: jest.fn().mockResolvedValue(suppressions),
      findUnique: jest.fn(async (args: { where: { email: string } }) => {
        const hit = suppressions.find((row) => row.email === args.where.email);
        return hit ? { reason: hit.reason } : null;
      }),
    },
    failedEmailBatch: {
      findMany: jest.fn().mockResolvedValue(extra.batches ?? []),
      updateMany: jest
        .fn()
        .mockImplementation((args: Prisma.FailedEmailBatchUpdateManyArgs) => {
          (args.where?.status ? batchUpdates : batchStamps).push(args);
          return Promise.resolve({ count: 1 });
        }),
    },
  };
  return { prisma, updates, batchUpdates, stamps, batchStamps };
}

function mockResend(
  impl: () => Promise<CreateEmailResponse>,
  batchImpl: jest.Mock = jest.fn(),
): RelaySender & { send: jest.Mock } {
  const send = jest.fn(impl);
  return {
    send,
    emails: { send },
    batch: { send: batchImpl } as unknown as RelaySender["batch"],
  };
}

const FROZEN_NOW_MS = new Date("2026-06-16T12:00:00Z").getTime();

describe("runEmailRetryTick — backoff schedule", () => {
  it("matches the outbound-webhook worker's 1m/5m/30m/2h/8h schedule", () => {
    expect(BACKOFF_MS).toEqual({
      1: 60_000,
      2: 5 * 60_000,
      3: 30 * 60_000,
      4: 2 * 60 * 60_000,
      5: 8 * 60 * 60_000,
    });
  });

  // attempts-before → expected nextRetryAt offset. The worker looks up the
  // slot for the NEXT attempt (attempts+2), matching the webhook worker: a row
  // at attempts=0 we just re-sent (attempt 1) → schedule attempt 2 at +5min.
  const cases: Array<[number, number]> = [
    [0, BACKOFF_MS[2]], // attempt 1 failed → attempt 2 slot (5m)
    [1, BACKOFF_MS[3]], // attempt 2 failed → attempt 3 slot (30m)
    [2, BACKOFF_MS[4]], // attempt 3 failed → attempt 4 slot (2h)
    [3, BACKOFF_MS[5]], // attempt 4 failed → attempt 5 slot (8h, last)
  ];
  it.each(cases)(
    "row at attempts=%i reschedules at +%ims on a re-send failure",
    async (attempts, expectedOffset) => {
      const stub = makePrismaStub(makeRow({ attempts }));
      const resend = mockResend(async () => {
        throw new Error("Resend 503");
      });

      const result = await runEmailRetryTick({
        prisma: stub.prisma,
        resend,
        now: () => FROZEN_NOW_MS,
      });

      expect(result.retried).toBe(1);
      const data = stub.updates[0].data as {
        status: string;
        attempts: number;
        nextRetryAt: Date;
      };
      expect(data.status).toBe("RETRY");
      expect(data.attempts).toBe(attempts + 1);
      expect(data.nextRetryAt.toISOString()).toBe(
        new Date(FROZEN_NOW_MS + expectedOffset).toISOString(),
      );
    },
  );

  it("flips to DEAD_LETTER instead of scheduling a 6th attempt and alerts Sentry (#1926, #531)", async () => {
    mockCaptureMessage.mockClear();
    const stub = makePrismaStub(makeRow({ attempts: 4, status: "RETRY" }));
    const resend = mockResend(async () => {
      throw new Error("Resend still down");
    });

    const result = await runEmailRetryTick({
      prisma: stub.prisma,
      resend,
      now: () => FROZEN_NOW_MS,
    });

    expect(result.deadLettered).toBe(1);
    expect(stub.updates[0].data).toMatchObject({
      status: "DEAD_LETTER",
      attempts: 5,
      lastError: "Resend still down",
    });
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining("email retry exhausted 5 attempts"),
      expect.objectContaining({
        level: "error",
        tags: expect.objectContaining({
          subsystem: "email",
          outbox_dead_letter: "true",
        }),
      }),
    );
    // No nextRetryAt churn on the terminal state.
    expect(
      (stub.updates[0].data as { nextRetryAt?: Date }).nextRetryAt,
    ).toBeUndefined();
  });
});

describe("runEmailRetryTick — success path", () => {
  it("marks SENT with sentAt and replays the stored fields verbatim", async () => {
    const stub = makePrismaStub(
      makeRow({
        textBody: "Thanks (text)",
        replyTo: "support@familiarisenow.com",
      }),
    );
    const resend = mockResend(async () => ({
      data: { id: "re-1" },
      error: null,
      headers: null,
    }));

    const result = await runEmailRetryTick({
      prisma: stub.prisma,
      resend,
      now: () => FROZEN_NOW_MS,
    });

    expect(result.sent).toBe(1);
    // Verbatim replay — exactly the persisted rendered fields — under the
    // same content-derived key the sender used, so Resend dedupes a replay.
    expect(resend.send).toHaveBeenCalledWith(
      {
        from: "Familiarise Payments <payments@mail.familiarisenow.com>",
        to: "user@example.com",
        subject: "Payment Confirmed",
        html: "<p>Thanks</p>",
        text: "Thanks (text)",
        replyTo: "support@familiarisenow.com",
      },
      expect.objectContaining({
        idempotencyKey: idempotencyKeyFor(
          {
            to: "user@example.com",
            subject: "Payment Confirmed",
            html: "<p>Thanks</p>",
          },
          "PAYMENT_SUCCESS",
          "fe-1",
        ),
      }),
    );
    // #1654 — the provider id lands on the row so support can trace it.
    expect(stub.updates[0].data).toMatchObject({
      status: "SENT",
      attempts: 1,
      lastError: null,
      resendId: "re-1",
    });
    expect(
      (stub.updates[0].data as { sentAt: Date }).sentAt.toISOString(),
    ).toBe(new Date(FROZEN_NOW_MS).toISOString());
  });

  it("falls back to the app default `from` when fromAddress is null", async () => {
    const stub = makePrismaStub(makeRow({ fromAddress: null }));
    const resend = mockResend(async () => ({
      data: { id: "re-2" },
      error: null,
      headers: null,
    }));

    await runEmailRetryTick({
      prisma: stub.prisma,
      resend,
      now: () => FROZEN_NOW_MS,
    });

    expect(resend.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Familiarise <onboarding@mail.familiarisenow.com>",
        text: undefined,
        replyTo: undefined,
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
  });

  it("treats a Resend error returned without throwing as a failure", async () => {
    const stub = makePrismaStub(makeRow());
    // Resend resolves with { error } on API-level failures (rate limit, invalid
    // key, validation) instead of throwing — this must NOT be read as a success.
    const resend = mockResend(async () => ({
      data: null,
      error: {
        message: "rate_limited",
        name: "rate_limit_exceeded",
        statusCode: 429,
      },
      headers: null,
    }));

    const result = await runEmailRetryTick({
      prisma: stub.prisma,
      resend,
      now: () => FROZEN_NOW_MS,
    });

    expect(result.sent).toBe(0);
    expect(result.retried).toBe(1);
    expect(stub.updates[0].data).toMatchObject({
      status: "RETRY",
      lastError: "rate_limit_exceeded: rate_limited",
    });
  });
});

describe("runEmailRetryTick — pacing (#1654)", () => {
  afterEach(() => jest.useRealTimers());

  it("waits the send gap between two rows so the drain stays under Resend's rate limit", async () => {
    jest.useFakeTimers();
    const rows = [makeRow({ id: "fe-a" }), makeRow({ id: "fe-b" })];
    const prisma: FailedEmailStore = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      failedEmail: {
        findMany: jest.fn().mockResolvedValue(rows),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      emailSuppression: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      failedEmailBatch: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
      },
    };
    const resend = mockResend(async () => ({
      data: { id: "re-x" },
      error: null,
      headers: null,
    }));

    const tick = runEmailRetryTick({
      prisma,
      resend,
      now: () => FROZEN_NOW_MS,
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(resend.send).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(SEND_GAP_MS - 1);
    expect(resend.send).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    const result = await tick;
    expect(resend.send).toHaveBeenCalledTimes(2);
    expect(result.sent).toBe(2);
  });
});

describe("runEmailRetryTick — terminal and expired rows (#1298)", () => {
  it("dead-letters a terminal error on attempt 1 instead of walking the backoff", async () => {
    const stub = makePrismaStub(makeRow());
    const resend = mockResend(async () => ({
      data: null,
      error: {
        message: "API key is invalid",
        name: "validation_error",
        statusCode: 401,
      },
      headers: null,
    }));

    const result = await runEmailRetryTick({
      prisma: stub.prisma,
      resend,
      now: () => FROZEN_NOW_MS,
    });

    expect(result.retried).toBe(0);
    expect(result.deadLettered).toBe(1);
    expect(stub.updates[0].data).toMatchObject({
      status: "DEAD_LETTER",
      attempts: 1,
      lastError: "validation_error: API key is invalid",
    });
  });

  it("treats a 422 validation_error (e.g. an example.com recipient) as terminal on attempt 1", async () => {
    // #1298 — the retry worker replayed such a row four times on 2026-09-14;
    // a body Resend rejects is never accepted by re-sending it unchanged.
    const stub = makePrismaStub(makeRow());
    const resend = mockResend(async () => ({
      data: null,
      error: {
        message:
          "Invalid `to` field. Please use our testing email address instead of domains like `example.com`.",
        name: "validation_error",
        statusCode: 422,
      },
      headers: null,
    }));

    const result = await runEmailRetryTick({
      prisma: stub.prisma,
      resend,
      now: () => FROZEN_NOW_MS,
    });

    expect(result.deadLettered).toBe(1);
    expect(stub.updates[0].data).toMatchObject({ status: "DEAD_LETTER" });
    expect(String(stub.updates[0].data.lastError)).toMatch(
      /^validation_error: Invalid `to` field/,
    );
  });

  it("dead-letters a credential row without sending: its body is redacted", async () => {
    const stub = makePrismaStub(makeRow({ emailType: "PASSWORD_RESET" }));
    const resend = mockResend(async () => ({
      data: { id: "re-never" },
      error: null,
      headers: null,
    }));

    const result = await runEmailRetryTick({
      prisma: stub.prisma,
      resend,
      now: () => FROZEN_NOW_MS,
    });

    expect(resend.send).not.toHaveBeenCalled();
    expect(result.deadLettered).toBe(1);
    expect(stub.updates[0].data).toMatchObject({ status: "DEAD_LETTER" });
    expect((stub.updates[0].data as { lastError: string }).lastError).toContain(
      "single-use credential",
    );
  });
});

describe("runEmailRetryTick — suppression and batch outbox (#1647)", () => {
  it("dead-letters a pending row whose recipient is suppressed without a send", async () => {
    const stub = makePrismaStub(makeRow({ recipient: "Dead@Example.com" }), {
      suppressions: [{ email: "dead@example.com", reason: "COMPLAINT" }],
    });
    const resend = mockResend(async () => ({
      data: { id: "re-never" },
      error: null,
      headers: null,
    }));

    const result = await runEmailRetryTick({
      prisma: stub.prisma,
      resend,
      now: () => FROZEN_NOW_MS,
    });

    expect(resend.send).not.toHaveBeenCalled();
    // An expected refusal: settled, but not a dead letter that pages.
    expect(result.refused).toBe(1);
    expect(result.deadLettered).toBe(0);
    expect(mockPostOpsChat).not.toHaveBeenCalled();
    expect(stub.updates[0].data).toMatchObject({
      status: "DEAD_LETTER",
      lastError: "suppressed:COMPLAINT",
    });
  });

  it("replays a PENDING batch row under its stored idempotency key and marks it SENT", async () => {
    const batch = makeBatchRow();
    const stub = makePrismaStub(makeRow({ status: "SENT" }), {
      batches: [batch],
    });
    stub.prisma.failedEmail.findMany = jest.fn().mockResolvedValue([]);
    const batchSend = jest.fn().mockResolvedValue({
      data: { data: [{ id: "re-b1" }] },
      error: null,
      headers: null,
    });
    const resend = mockResend(async () => {
      throw new Error("single send must not run");
    }, batchSend);

    const result = await runEmailRetryTick({
      prisma: stub.prisma,
      resend,
      now: () => FROZEN_NOW_MS,
    });

    expect(batchSend).toHaveBeenCalledWith(
      batch.payload,
      expect.objectContaining({ idempotencyKey: "NEWSLETTER_BROADCAST/abc" }),
    );
    expect(result).toMatchObject({ batchesScanned: 1, batchesSent: 1 });
    expect(stub.batchUpdates[0].data).toMatchObject({
      status: "SENT",
      attempts: 1,
      lastError: null,
    });
  });
});

describe("runEmailRetryTick — no sender", () => {
  const OLD_KEY = process.env.RESEND_API_KEY;
  beforeEach(() => {
    delete process.env.RESEND_API_KEY;
  });
  afterEach(() => {
    if (OLD_KEY === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = OLD_KEY;
  });

  it("bails cleanly (no scan) when there is no Resend sender available", async () => {
    const stub = makePrismaStub(makeRow());

    const result = await runEmailRetryTick({
      prisma: stub.prisma,
      // No `resend` injected and RESEND_API_KEY unset in the test env.
      now: () => FROZEN_NOW_MS,
    });

    expect(result.scanned).toBe(0);
    expect(result.errors[0]).toContain("RESEND_API_KEY not configured");
    expect(stub.prisma.failedEmail.findMany).not.toHaveBeenCalled();
  });
});

describe("runEmailRetryTick — provider window anchored on the first attempt", () => {
  const HOUR = 3_600_000;
  const sent = async () => ({
    data: { id: "re-w" },
    error: null,
    headers: null,
  });

  it("sends a never-attempted row older than 24 h and stamps its first attempt", async () => {
    const stub = makePrismaStub(
      makeRow({ createdAt: new Date(FROZEN_NOW_MS - 72 * HOUR) }),
    );
    const resend = mockResend(sent);

    const result = await runEmailRetryTick({
      prisma: stub.prisma,
      resend,
      now: () => FROZEN_NOW_MS,
    });

    expect(result.sent).toBe(1);
    expect(resend.send).toHaveBeenCalledTimes(1);
    expect(stub.stamps).toEqual([
      {
        where: { id: "fe-1", firstAttemptAt: null },
        data: { firstAttemptAt: new Date(FROZEN_NOW_MS) },
      },
    ]);
  });

  it("refuses a row first attempted 23 h ago without sending or re-stamping it", async () => {
    const stub = makePrismaStub(
      makeRow({ firstAttemptAt: new Date(FROZEN_NOW_MS - 23 * HOUR) }),
    );
    const resend = mockResend(sent);

    const result = await runEmailRetryTick({
      prisma: stub.prisma,
      resend,
      now: () => FROZEN_NOW_MS,
    });

    expect(resend.send).not.toHaveBeenCalled();
    expect(stub.stamps).toEqual([]);
    expect(result.deadLettered).toBe(1);
    expect(stub.updates[0].data).toEqual({
      status: "DEAD_LETTER",
      lastError: "review:provider_acceptance_unknown",
    });
  });

  it("keeps the first stamp across retries and replays under the same key inside the window", async () => {
    const row = makeRow();
    const prisma: FailedEmailStore = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      failedEmail: {
        findMany: jest.fn(async () => [{ ...row }]),
        // Mirrors the SQL CAS: a settle needs an unsettled row, a stamp an unset anchor.
        updateMany: jest.fn(async (args: Prisma.FailedEmailUpdateManyArgs) => {
          if (args.where?.status) {
            if (row.status !== "PENDING" && row.status !== "RETRY") {
              return { count: 0 };
            }
            Object.assign(row, args.data);
            return { count: 1 };
          }
          if (row.firstAttemptAt !== null) return { count: 0 };
          row.firstAttemptAt = args.data.firstAttemptAt as Date;
          return { count: 1 };
        }),
      },
      emailSuppression: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      failedEmailBatch: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
      },
    };
    const send = jest
      .fn()
      .mockRejectedValueOnce(new Error("Resend 503"))
      .mockResolvedValueOnce({ data: { id: "re-2" }, error: null });
    const resend: RelaySender = {
      emails: { send },
      batch: { send: jest.fn() } as unknown as RelaySender["batch"],
    };

    await runEmailRetryTick({ prisma, resend, now: () => FROZEN_NOW_MS });
    const later = FROZEN_NOW_MS + 22 * HOUR;
    const second = await runEmailRetryTick({
      prisma,
      resend,
      now: () => later,
    });

    expect(second.sent).toBe(1);
    expect(row.firstAttemptAt).toEqual(new Date(FROZEN_NOW_MS));
    expect(send.mock.calls[1][1].idempotencyKey).toBe(
      send.mock.calls[0][1].idempotencyKey,
    );
  });

  it("acknowledges a recorded provider receipt without sending again", async () => {
    const stub = makePrismaStub(makeRow({ resendId: "re-accepted" }));
    const resend = mockResend(sent);

    const result = await runEmailRetryTick({
      prisma: stub.prisma,
      resend,
      now: () => FROZEN_NOW_MS,
    });

    expect(result.sent).toBe(1);
    expect(resend.send).not.toHaveBeenCalled();
    expect(stub.updates[0].data).toMatchObject({ status: "SENT" });
  });
});

describe("runEmailRetryTick — attempt-time recipient recheck", () => {
  const sent = async () => ({
    data: { id: "re-p" },
    error: null,
    headers: null,
  });
  const account = (overrides: Record<string, unknown> = {}) => ({
    email: "user@example.com",
    erasedAt: null,
    notificationPreferences: null,
    ...overrides,
  });

  beforeEach(() => mockPostOpsChat.mockClear());

  it("dead-letters a row whose account turned the category off, without paging", async () => {
    const stub = makePrismaStub(
      makeRow({ deliveryUserId: "u1", deliveryCategory: "payments" }),
    );
    jest.mocked(stub.prisma.user.findUnique).mockResolvedValue(
      account({
        notificationPreferences: {
          allNotifications: true,
          emailEnabled: true,
          appointmentReminders: true,
          paymentNotifications: false,
          subscriptionAlerts: true,
          trialNotifications: true,
          supportUpdates: true,
          feedbackAlerts: true,
          orgBillingAlerts: true,
          orgMembershipAlerts: true,
          orgProgramAlerts: true,
        },
      }),
    );
    const resend = mockResend(sent);

    const result = await runEmailRetryTick({
      prisma: stub.prisma,
      resend,
      now: () => FROZEN_NOW_MS,
    });

    expect(resend.send).not.toHaveBeenCalled();
    expect(stub.stamps).toEqual([]);
    expect(result).toMatchObject({ refused: 1, deadLettered: 0 });
    expect(stub.updates[0].data).toEqual({
      status: "DEAD_LETTER",
      lastError: "policy:preference_changed",
    });
    expect(mockPostOpsChat).not.toHaveBeenCalled();
  });

  it("sends a required notice whatever the optional switches say", async () => {
    const stub = makePrismaStub(
      makeRow({ deliveryUserId: "u1", deliveryCategory: null }),
    );
    jest.mocked(stub.prisma.user.findUnique).mockResolvedValue(
      account({
        notificationPreferences: {
          allNotifications: false,
          emailEnabled: false,
          appointmentReminders: false,
          paymentNotifications: false,
          subscriptionAlerts: false,
          trialNotifications: false,
          supportUpdates: false,
          feedbackAlerts: false,
          orgBillingAlerts: false,
          orgMembershipAlerts: false,
          orgProgramAlerts: false,
        },
      }),
    );
    const resend = mockResend(sent);

    const result = await runEmailRetryTick({
      prisma: stub.prisma,
      resend,
      now: () => FROZEN_NOW_MS,
    });

    expect(result.sent).toBe(1);
    expect(stub.prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u1" } }),
    );
  });

  it("rechecks suppression for the row immediately before its send", async () => {
    const stub = makePrismaStub(makeRow({ recipient: " User@Example.com" }));
    const resend = mockResend(sent);

    await runEmailRetryTick({
      prisma: stub.prisma,
      resend,
      now: () => FROZEN_NOW_MS,
    });

    expect(stub.prisma.emailSuppression.findUnique).toHaveBeenCalledWith({
      where: { email: "user@example.com" },
      select: { reason: true },
    });
    expect(resend.send).toHaveBeenCalledTimes(1);
  });

  it("leaves the row pending and reports once when the account cannot be read", async () => {
    const stub = makePrismaStub(
      makeRow({ deliveryUserId: "u1", deliveryCategory: "payments" }),
    );
    jest
      .mocked(stub.prisma.user.findUnique)
      .mockRejectedValueOnce(new Error("pool unavailable"));
    const resend = mockResend(sent);

    const result = await runEmailRetryTick({
      prisma: stub.prisma,
      resend,
      now: () => FROZEN_NOW_MS,
    });

    expect(resend.send).not.toHaveBeenCalled();
    expect(stub.updates).toEqual([]);
    expect(stub.stamps).toEqual([]);
    expect(result.errors).toEqual([
      "1 email(s) left pending: recipient recheck failed (pool unavailable)",
    ]);
  });
});

describe("runEmailRetryTick — batch replay safety", () => {
  const HOUR = 3_600_000;
  const twoRecipients = [
    { from: "a@x", to: "keep@y", subject: "s", html: "<p/>" },
    { from: "a@x", to: "Gone@Y", subject: "s", html: "<p/>" },
  ];
  function batchStub(
    batch: FailedEmailBatch,
    suppressions: Pick<EmailSuppression, "email" | "reason">[] = [],
  ) {
    const stub = makePrismaStub(makeRow(), {
      batches: [batch],
      suppressions,
    });
    stub.prisma.failedEmail.findMany = jest.fn().mockResolvedValue([]);
    const batchSend = jest.fn().mockResolvedValue({
      data: { data: [{ id: "re-b" }] },
      error: null,
      headers: null,
    });
    const resend = mockResend(async () => {
      throw new Error("single send must not run");
    }, batchSend);
    return { ...stub, batchSend, resend };
  }

  it("dead-letters a malformed stored payload before calling the vendor", async () => {
    const t = batchStub(makeBatchRow({ payload: [{ to: "b@y" }] }));

    const result = await runEmailRetryTick({
      prisma: t.prisma,
      resend: t.resend,
      now: () => FROZEN_NOW_MS,
    });

    expect(t.batchSend).not.toHaveBeenCalled();
    expect(result.batchesDeadLettered).toBe(1);
    expect(t.batchUpdates[0].data).toEqual({
      status: "DEAD_LETTER",
      lastError: "invalid batch payload",
    });
  });

  it("sends a never-attempted batch older than 24 h and stamps it first", async () => {
    const t = batchStub(
      makeBatchRow({ createdAt: new Date(FROZEN_NOW_MS - 72 * HOUR) }),
    );

    const result = await runEmailRetryTick({
      prisma: t.prisma,
      resend: t.resend,
      now: () => FROZEN_NOW_MS,
    });

    expect(result.batchesSent).toBe(1);
    expect(t.batchStamps).toEqual([
      {
        where: { id: "feb-1", firstAttemptAt: null },
        data: { firstAttemptAt: new Date(FROZEN_NOW_MS) },
      },
    ]);
  });

  it("refuses a batch first attempted 23 h ago and keeps its payload and key", async () => {
    const batch = makeBatchRow({
      firstAttemptAt: new Date(FROZEN_NOW_MS - 23 * HOUR),
    });
    const t = batchStub(batch);

    const result = await runEmailRetryTick({
      prisma: t.prisma,
      resend: t.resend,
      now: () => FROZEN_NOW_MS,
    });

    expect(t.batchSend).not.toHaveBeenCalled();
    expect(result.batchesDeadLettered).toBe(1);
    expect(t.batchUpdates[0].data).toEqual({
      status: "DEAD_LETTER",
      lastError: "review:provider_acceptance_unknown",
    });
    expect(t.batchStamps).toEqual([]);
  });

  it("drops a newly suppressed recipient from a never-attempted batch, storing the narrowed payload with the stamp", async () => {
    const t = batchStub(makeBatchRow({ payload: twoRecipients }), [
      { email: "gone@y", reason: "HARD_BOUNCE" },
    ]);

    const result = await runEmailRetryTick({
      prisma: t.prisma,
      resend: t.resend,
      now: () => FROZEN_NOW_MS,
    });

    expect(result.batchesSent).toBe(1);
    expect(t.batchStamps).toEqual([
      {
        where: { id: "feb-1", firstAttemptAt: null },
        data: {
          firstAttemptAt: new Date(FROZEN_NOW_MS),
          payload: [twoRecipients[0]],
        },
      },
    ]);
    expect(t.batchSend).toHaveBeenCalledWith(
      [twoRecipients[0]],
      expect.objectContaining({ idempotencyKey: "NEWSLETTER_BROADCAST/abc" }),
    );
  });

  it("does not narrow a batch the provider may already have accepted", async () => {
    const t = batchStub(
      makeBatchRow({
        payload: twoRecipients,
        firstAttemptAt: new Date(FROZEN_NOW_MS - HOUR),
      }),
      [{ email: "gone@y", reason: "COMPLAINT" }],
    );

    const result = await runEmailRetryTick({
      prisma: t.prisma,
      resend: t.resend,
      now: () => FROZEN_NOW_MS,
    });

    expect(t.batchSend).not.toHaveBeenCalled();
    expect(result.batchesDeadLettered).toBe(1);
    expect(t.batchUpdates[0].data).toEqual({
      status: "DEAD_LETTER",
      lastError: "review:batch_recipient_suppressed",
    });
  });

  it("settles a batch whose every recipient is now suppressed as an expected refusal", async () => {
    const t = batchStub(makeBatchRow(), [{ email: "b@y", reason: "MANUAL" }]);

    const result = await runEmailRetryTick({
      prisma: t.prisma,
      resend: t.resend,
      now: () => FROZEN_NOW_MS,
    });

    expect(t.batchSend).not.toHaveBeenCalled();
    expect(result).toMatchObject({ refused: 1, batchesDeadLettered: 0 });
    expect(t.batchUpdates[0].data).toEqual({
      status: "DEAD_LETTER",
      lastError: "suppressed:all_recipients",
    });
  });
});

describe("runEmailRetryTick — conditional settles", () => {
  it("never overwrites a row another attempt settled while this send was in flight", async () => {
    const stub = makePrismaStub(makeRow());
    // The inline attempt marks the row SENT first, so every settle misses.
    stub.prisma.failedEmail.updateMany = jest.fn(
      async (args: Prisma.FailedEmailUpdateManyArgs) => {
        if (args.where?.status) stub.updates.push(args);
        return { count: args.where?.status ? 0 : 1 };
      },
    );
    const resend = mockResend(async () => {
      throw new Error("Resend 503");
    });

    const result = await runEmailRetryTick({
      prisma: stub.prisma,
      resend,
      now: () => FROZEN_NOW_MS,
    });

    expect(stub.updates[0].where).toEqual({
      id: "fe-1",
      status: { in: ["PENDING", "RETRY"] },
    });
    expect(result).toMatchObject({ sent: 0, retried: 0, deadLettered: 0 });
  });

  it("filters every batch settle on an unsettled status", async () => {
    const stub = makePrismaStub(makeRow(), {
      batches: [makeBatchRow({ sentAt: new Date(FROZEN_NOW_MS) })],
    });
    stub.prisma.failedEmail.findMany = jest.fn().mockResolvedValue([]);

    await runEmailRetryTick({
      prisma: stub.prisma,
      resend: mockResend(async () => ({
        data: { id: "re-unused" },
        error: null,
        headers: null,
      })),
      now: () => FROZEN_NOW_MS,
    });

    expect(stub.batchUpdates[0].where).toMatchObject({
      status: { in: ["PENDING", "RETRY"] },
    });
  });
});
