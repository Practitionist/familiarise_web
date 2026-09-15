/**
 * @jest-environment node
 */

/**
 * #1298 — the send core. Pins the four facts that made prod email silently
 * dead: a missing key must dead-letter (not early-return), the idempotency key
 * the worker derives from a stored row must equal the sender's, a terminal
 * Resend error must classify as such, and an expired link must not replay.
 */

const mockSend = jest.fn();
const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockCaptureException = jest.fn();

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: (...args: unknown[]) => mockSend(...args) },
  })),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    failedEmail: {
      create: (...args: unknown[]) => mockCreate(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import {
  attempt,
  deliver,
  stage,
  type RenderedEmail,
} from "@/lib/email/deliver";
import { idempotencyKeyFor } from "@/lib/email/idempotency";
import { isExpiredForReplay, isTerminalSendError } from "@/lib/email/classify";

const message: RenderedEmail = {
  from: "Familiarise <onboarding@mail.familiarisenow.com>",
  to: "user@example.com",
  subject: "Verify your Familiarise email address",
  html: "<p>token=abc</p>",
  text: "token=abc",
};

const OLD_KEY = process.env.RESEND_API_KEY;
afterEach(() => {
  if (OLD_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = OLD_KEY;
  jest.clearAllMocks();
});

describe("deliver — missing key (#1298 Fix 3)", () => {
  it("dead-letters the message instead of returning early", async () => {
    delete process.env.RESEND_API_KEY;
    mockCreate.mockResolvedValue({ id: "fe-1" });
    mockUpdate.mockResolvedValue({});

    const result = await deliver(message, "EMAIL_VERIFICATION");

    expect(result.success).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
    // #1654 — the row is staged BEFORE the send, then annotated with the cause.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const data = mockCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      recipient: "user@example.com",
      emailType: "EMAIL_VERIFICATION",
      status: "PENDING",
      htmlBody: "<p>token=abc</p>",
      textBody: "token=abc",
      // Every transactional message gets a real Reply-To.
      replyTo: "support@familiarisenow.com",
    });
    expect(mockUpdate.mock.calls[0][0].data.lastError).toContain(
      "not configured",
    );
    // A missing key stays PENDING: the row replays once the key exists.
    expect(mockUpdate.mock.calls[0][0].data.status).toBeUndefined();
  });
});

describe("stage + attempt (#1654)", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test";
    mockUpdate.mockResolvedValue({});
  });

  it("stages inside the caller's transaction, then a successful attempt marks SENT with the Resend id", async () => {
    const txCreate = jest.fn().mockResolvedValue({ id: "fe-tx" });
    const tx = { failedEmail: { create: txCreate } } as never;
    mockSend.mockResolvedValue({
      data: { id: "re-123" },
      error: null,
      headers: null,
    });

    const staged = await stage(message, "PAYMENT_SUCCESS", {
      tx,
      entityRef: "payment:pay-1",
    });
    expect(staged).toEqual({
      id: "fe-tx",
      idempotencyKey: idempotencyKeyFor(message, "PAYMENT_SUCCESS"),
    });
    // The row went through the transaction, not the global client.
    expect(txCreate.mock.calls[0][0].data).toMatchObject({
      status: "PENDING",
      lastError: null,
      entityRef: "payment:pay-1",
    });
    expect(mockCreate).not.toHaveBeenCalled();

    const result = await attempt(staged, message, "PAYMENT_SUCCESS", {
      budgetMs: 3_000,
    });
    expect(result.success).toBe(true);
    // The send carries the staged key and an abort signal under the budget.
    const options = mockSend.mock.calls[0][1];
    expect(options.idempotencyKey).toBe(staged?.idempotencyKey);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "fe-tx" },
      data: expect.objectContaining({
        status: "SENT",
        resendId: "re-123",
        lastError: null,
      }),
    });
  });

  it("leaves the row PENDING and untouched on a timeout, without paging", async () => {
    mockSend.mockRejectedValue(
      new DOMException("The operation was aborted", "AbortError"),
    );

    const result = await attempt(
      { id: "fe-2", idempotencyKey: "k" },
      message,
      "EMAIL_VERIFICATION",
      { budgetMs: 10 },
    );

    expect(result).toMatchObject({ success: false, staged: true });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("dead-letters the row on a terminal error and pages once per reason", async () => {
    mockSend.mockResolvedValue({
      data: null,
      error: { message: "API key is invalid", name: "validation_error" },
      headers: null,
    });

    const result = await attempt(
      { id: "fe-3", idempotencyKey: "k" },
      message,
      "EMAIL_VERIFICATION",
      { budgetMs: 3_000 },
    );

    expect(result.success).toBe(false);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "fe-3" },
      data: {
        status: "DEAD_LETTER",
        lastError: "validation_error: API key is invalid",
      },
    });
    expect(mockCaptureException.mock.calls[0][1]).toMatchObject({
      level: "error",
      fingerprint: ["email-send-terminal", "invalid_api_key"],
    });
  });
});

describe("idempotencyKeyFor", () => {
  it("is stable for identical content and differs when the html differs", () => {
    const a = idempotencyKeyFor(message, "EMAIL_VERIFICATION");
    const b = idempotencyKeyFor({ ...message }, "EMAIL_VERIFICATION");
    const c = idempotencyKeyFor(
      { ...message, html: "<p>token=xyz</p>" },
      "EMAIL_VERIFICATION",
    );
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^EMAIL_VERIFICATION\/[0-9a-f]{48}$/);
    expect(a.length).toBeLessThanOrEqual(256);
  });

  it("gives the worker the same key from the stored row that the sender used", async () => {
    process.env.RESEND_API_KEY = "re_test";
    mockSend.mockResolvedValue({
      data: null,
      error: { message: "rate_limited", name: "rate_limit_exceeded" },
      headers: null,
    });
    mockCreate.mockResolvedValue({ id: "fe-1" });
    mockUpdate.mockResolvedValue({});

    await deliver(message, "EMAIL_VERIFICATION");

    const senderKey = mockSend.mock.calls[0][1].idempotencyKey;
    const row = mockCreate.mock.calls[0][0].data;
    const workerKey = idempotencyKeyFor(
      { to: row.recipient, subject: row.subject, html: row.htmlBody },
      row.emailType,
    );
    expect(workerKey).toBe(senderKey);
    // A transient error stays a warning; only terminal causes page.
    expect(mockCaptureException.mock.calls[0][1]).toMatchObject({
      level: "warning",
    });
  });
});

describe("isTerminalSendError", () => {
  it("recognises a dead key and an unverified domain, not a transient failure", () => {
    expect(isTerminalSendError("API key is invalid")).toBe(true);
    expect(
      isTerminalSendError("The mail.familiarisenow.com domain is not verified"),
    ).toBe(true);
    expect(isTerminalSendError("Resend 503")).toBe(false);
    expect(isTerminalSendError("fetch failed: ETIMEDOUT")).toBe(false);
    expect(isTerminalSendError(undefined)).toBe(false);
  });
});

describe("isExpiredForReplay", () => {
  const now = new Date("2026-09-14T12:00:00Z");
  it("expires a verification link after its hour and never expires a welcome", () => {
    expect(
      isExpiredForReplay(
        "EMAIL_VERIFICATION",
        new Date(now.getTime() - 61 * 60_000),
        now,
      ),
    ).toBe(true);
    expect(
      isExpiredForReplay(
        "EMAIL_VERIFICATION",
        new Date(now.getTime() - 59 * 60_000),
        now,
      ),
    ).toBe(false);
    expect(
      isExpiredForReplay(
        "WELCOME",
        new Date(now.getTime() - 3 * 24 * 60 * 60_000),
        now,
      ),
    ).toBe(false);
  });
});
