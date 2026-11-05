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
    deliveryPolicy: null,
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
    idempotencyKey: "WAITLIST_BROADCAST/abc",
    emailType: "WAITLIST_BROADCAST",
    payload: [{ from: "a@x", to: "b@y", subject: "s", html: "<p/>" }],
    status: "PENDING",
    attempts: 0,
    nextRetryAt: null,
    lastError: null,
    sentAt: null,
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
  const updates: Prisma.FailedEmailUpdateArgs[] = [];
  const batchUpdates: Prisma.FailedEmailBatchUpdateArgs[] = [];
  const prisma: FailedEmailStore = {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    waitlist: {
      findMany: jest.fn(async (args) => {
        const emails = args.where?.email;
        return typeof emails === "object" &&
          emails &&
          "in" in emails &&
          Array.isArray(emails.in)
          ? emails.in.map((email) => ({ email }))
          : [];
      }),
    },
    failedEmail: {
      findMany: jest.fn().mockResolvedValue([initialRow]),
      update: jest
        .fn()
        .mockImplementation((args: Prisma.FailedEmailUpdateArgs) => {
          updates.push(args);
          return Promise.resolve({ ...initialRow, ...args.data });
        }),
    },
    emailSuppression: {
      findMany: jest.fn().mockResolvedValue(extra.suppressions ?? []),
    },
    failedEmailBatch: {
      findMany: jest.fn().mockResolvedValue(extra.batches ?? []),
      update: jest
        .fn()
        .mockImplementation((args: Prisma.FailedEmailBatchUpdateArgs) => {
          batchUpdates.push(args);
          return Promise.resolve({ ...makeBatchRow(), ...args.data });
        }),
    },
  };
  return { prisma, updates, batchUpdates };
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
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      waitlist: {
        findMany: jest.fn(async (args) => {
          const emails = args.where?.email;
          return typeof emails === "object" &&
            emails &&
            "in" in emails &&
            Array.isArray(emails.in)
            ? emails.in.map((email) => ({ email }))
            : [];
        }),
      },
      failedEmail: {
        findMany: jest.fn().mockResolvedValue(rows),
        update: jest
          .fn()
          .mockImplementation((args) =>
            Promise.resolve({ ...rows[0], ...args.data }),
          ),
      },
      emailSuppression: { findMany: jest.fn().mockResolvedValue([]) },
      failedEmailBatch: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
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
    expect(result.deadLettered).toBe(1);
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
      expect.objectContaining({ idempotencyKey: "WAITLIST_BROADCAST/abc" }),
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

describe("batch audience safety at replay", () => {
  it.each(["marketingEmails", "allNotifications", "emailEnabled"])(
    "never replays a newsletter after the account disables %s",
    async (field) => {
      const { prisma, batchUpdates } = makePrismaStub(makeRow(), {
        batches: [makeBatchRow()],
      });
      jest.mocked(prisma.user.findMany).mockResolvedValue([
        {
          email: "B@Y",
          erasedAt: null,
          consentArtifacts: [{ id: "grant" }],
          notificationPreferences: {
            marketingEmails: true,
            allNotifications: true,
            emailEnabled: true,
            [field]: false,
          },
        },
      ]);
      const sender = mockResend(async () => ({
        data: { id: "single-send" },
        error: null,
        headers: null,
      }));
      const result = await runEmailRetryTick({
        prisma,
        resend: sender,
        now: () => FROZEN_NOW_MS,
      });
      expect(sender.batch.send).not.toHaveBeenCalled();
      expect(result.batchesDeadLettered).toBe(1);
      expect(batchUpdates[0].data).toMatchObject({
        status: "DEAD_LETTER",
        lastError:
          "batch audience changed: consent, preferences or suppression",
      });
    },
  );

  it.each(["unsubscribed", "suppressed"])(
    "never replays a batch after a recipient is %s",
    async (reason) => {
      const { prisma, batchUpdates } = makePrismaStub(makeRow(), {
        batches: [makeBatchRow()],
      });
      if (reason === "unsubscribed")
        jest.mocked(prisma.waitlist.findMany).mockResolvedValue([]);
      else
        jest
          .mocked(prisma.emailSuppression.findMany)
          .mockResolvedValue([{ email: "b@y", reason: "COMPLAINT" }]);
      const sender = mockResend(async () => ({
        data: { id: "sent" },
        error: null,
        headers: null,
      }));
      const result = await runEmailRetryTick({
        prisma,
        resend: sender,
        now: () => FROZEN_NOW_MS,
      });
      expect(sender.batch.send).not.toHaveBeenCalled();
      expect(result.batchesDeadLettered).toBe(1);
      expect(batchUpdates[0].data.lastError).toBe(
        "batch audience changed: consent, preferences or suppression",
      );
    },
  );
  it("rejects malformed persisted batches before calling the vendor", async () => {
    const { prisma } = makePrismaStub(makeRow(), {
      batches: [makeBatchRow({ payload: { to: "invalid" } })],
    });
    const sender = mockResend(async () => ({
      data: { id: "sent" },
      error: null,
      headers: null,
    }));
    const result = await runEmailRetryTick({
      prisma,
      resend: sender,
      now: () => FROZEN_NOW_MS,
    });
    expect(sender.batch.send).not.toHaveBeenCalled();
    expect(result.batchesDeadLettered).toBe(1);
  });
});

describe("individual account policy at relay", () => {
  it("does not send an optional notice after the master switch is disabled", async () => {
    const { prisma, updates } = makePrismaStub(
      makeRow({ deliveryPolicy: { userId: "account", category: "payments" } }),
    );
    jest.mocked(prisma.user.findUnique).mockResolvedValue({
      email: "user@example.com",
      erasedAt: null,
      orgWorkspaceProfile: null,
      notificationPreferences: {
        allNotifications: false,
        emailEnabled: true,
        appointmentReminders: true,
        paymentNotifications: true,
        subscriptionAlerts: true,
        trialNotifications: true,
        supportUpdates: true,
        feedbackAlerts: true,
        orgBillingAlerts: true,
        orgMembershipAlerts: true,
        orgProgramAlerts: true,
      },
    });
    const sender = mockResend(async () => ({
      data: { id: "sent" },
      error: null,
      headers: null,
    }));
    const result = await runEmailRetryTick({
      prisma,
      resend: sender,
      now: () => FROZEN_NOW_MS,
    });
    expect(sender.send).not.toHaveBeenCalled();
    expect(result.deadLettered).toBe(1);
    expect(updates[0].data).toMatchObject({
      status: "DEAD_LETTER",
      lastError: "policy:preference_changed",
    });
  });
  it("sends required account mail without an optional preference gate", async () => {
    const { prisma } = makePrismaStub(
      makeRow({ deliveryPolicy: { userId: "account", category: null } }),
    );
    jest.mocked(prisma.user.findUnique).mockResolvedValue({
      email: "user@example.com",
      erasedAt: null,
      orgWorkspaceProfile: { notificationRoutingMode: "NEITHER" },
      notificationPreferences: null,
    });
    const sender = mockResend(async () => ({
      data: { id: "sent" },
      error: null,
      headers: null,
    }));
    expect(
      (
        await runEmailRetryTick({
          prisma,
          resend: sender,
          now: () => FROZEN_NOW_MS,
        })
      ).sent,
    ).toBe(1);
    expect(sender.send.mock.calls[0][0]).not.toHaveProperty("deliveryPolicy");
  });
  it("propagates account read failures without attempting or dead-lettering mail", async () => {
    const { prisma, updates } = makePrismaStub(
      makeRow({ deliveryPolicy: { userId: "account", category: "payments" } }),
    );
    jest
      .mocked(prisma.user.findUnique)
      .mockRejectedValueOnce(new Error("pool unavailable"));
    const sender = mockResend(async () => ({
      data: { id: "sent" },
      error: null,
      headers: null,
    }));
    await expect(
      runEmailRetryTick({ prisma, resend: sender, now: () => FROZEN_NOW_MS }),
    ).rejects.toThrow("pool unavailable");
    expect(sender.send).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });
});
