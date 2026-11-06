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
const mockUpdateMany = jest.fn();
const mockFindSuppression = jest.fn();
const mockPolicyUser = jest.fn();
const mockCaptureException = jest.fn();

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: (...args: unknown[]) => mockSend(...args) },
  })),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: (...args: unknown[]) => mockPolicyUser(...args) },
    failedEmail: {
      create: (...args: unknown[]) => mockCreate(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
    },
    emailSuppression: {
      findUnique: (...args: unknown[]) => mockFindSuppression(...args),
    },
  },
}));

jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));
jest.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import { SUPPORT_EMAIL } from "@/lib/company";
import {
  attempt,
  deliver,
  stage,
  type RenderedEmail,
} from "@/lib/email/deliver";
import { idempotencyKeyFor } from "@/lib/email/idempotency";
import { isTerminalSendError } from "@/lib/email/classify";

const message: RenderedEmail = {
  from: "Familiarise <onboarding@mail.familiarisenow.com>",
  to: "user@example.com",
  subject: "Welcome to Familiarise!",
  html: "<p>token=abc</p>",
  text: "token=abc",
};

const OLD_KEY = process.env.RESEND_API_KEY;
beforeEach(() => {
  mockFindSuppression.mockResolvedValue(null);
  mockUpdateMany.mockResolvedValue({ count: 1 });
});
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

    const result = await deliver(message, "WELCOME");

    expect(result.success).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
    // #1654 — the row is staged BEFORE the send, then annotated with the cause.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const data = mockCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      recipient: "user@example.com",
      emailType: "WELCOME",
      status: "PENDING",
      htmlBody: "<p>token=abc</p>",
      textBody: "token=abc",
      // Every transactional message gets a real Reply-To.
      replyTo: SUPPORT_EMAIL,
    });
    expect(mockUpdate.mock.calls[0][0].data.lastError).toContain(
      "not configured",
    );
    // A missing key stays PENDING: the row replays once the key exists.
    expect(mockUpdate.mock.calls[0][0].data.status).toBeUndefined();
    // Resend never saw the key, so the replay window is not started.
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});

describe("stage + attempt (#1654)", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test";
    mockUpdate.mockResolvedValue({});
  });

  it("stages inside the caller's transaction, then a successful attempt marks SENT with the Resend id", async () => {
    const txCreate = jest.fn().mockResolvedValue({ id: "fe-tx" });
    const tx = {
      failedEmail: { create: txCreate },
      // #1647 — the suppression read goes through the same transaction.
      emailSuppression: { findUnique: jest.fn().mockResolvedValue(null) },
    } as never;
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
      idempotencyKey: idempotencyKeyFor(message, "PAYMENT_SUCCESS", "fe-tx"),
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
      "WELCOME",
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
      "WELCOME",
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

describe("suppressed recipient (#1647)", () => {
  it("dead-letters the row at stage time and never calls Resend", async () => {
    process.env.RESEND_API_KEY = "re_test";
    mockFindSuppression.mockResolvedValue({
      email: "user@example.com",
      reason: "HARD_BOUNCE",
    });
    mockCreate.mockResolvedValue({ id: "fe-s" });

    const result = await deliver(message, "WELCOME");

    expect(result).toMatchObject({ success: false, staged: true });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockCreate.mock.calls[0][0].data).toMatchObject({
      status: "DEAD_LETTER",
      lastError: "suppressed:HARD_BOUNCE",
    });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});

describe("idempotencyKeyFor", () => {
  it("is stable for identical content and differs when the html differs", () => {
    const a = idempotencyKeyFor(message, "WELCOME");
    const b = idempotencyKeyFor({ ...message }, "WELCOME");
    const c = idempotencyKeyFor(
      { ...message, html: "<p>token=xyz</p>" },
      "WELCOME",
    );
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^WELCOME\/[0-9a-f]{48}$/);
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

    await deliver(message, "WELCOME");

    const senderKey = mockSend.mock.calls[0][1].idempotencyKey;
    const row = mockCreate.mock.calls[0][0].data;
    const workerKey = idempotencyKeyFor(
      { to: row.recipient, subject: row.subject, html: row.htmlBody },
      row.emailType,
      "fe-1",
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

describe("credential emails", () => {
  it("stage a redacted body so the outbox never holds a live code or link", async () => {
    process.env.RESEND_API_KEY = "re_test";
    mockCreate.mockResolvedValue({ id: "fe-cred" });
    mockSend.mockResolvedValue({ data: { id: "re-cred" }, error: null });
    mockUpdate.mockResolvedValue({});

    await deliver(
      { ...message, html: "<p>123456</p>", text: "123456" },
      "EMAIL_VERIFICATION",
    );

    const data = mockCreate.mock.calls[0][0].data;
    expect(data.htmlBody).not.toContain("123456");
    expect(data.textBody).toBeNull();
    // The inline send still carries the real message.
    expect(mockSend.mock.calls[0][0].html).toContain("123456");
  });
});

describe("per-recipient daily cap", () => {
  it("drops the sixth reset mail to one address before staging, and leaves other types alone", async () => {
    process.env.RESEND_API_KEY = "re_test";
    mockCreate.mockResolvedValue({ id: "fe-cap" });
    mockUpdate.mockResolvedValue({});
    mockSend.mockResolvedValue({ data: { id: "rs-cap" }, error: null });
    const reset = { ...message, to: "Capped@Example.com " };

    for (let i = 0; i < 5; i++) {
      expect((await deliver(reset, "PASSWORD_RESET")).success).toBe(true);
    }
    const capped = await deliver(
      { ...reset, to: "capped@example.com" },
      "PASSWORD_RESET",
    );

    expect(capped.success).toBe(false);
    expect(mockCreate).toHaveBeenCalledTimes(5);
    expect(mockSend).toHaveBeenCalledTimes(5);
    expect((await deliver(reset, "WELCOME")).success).toBe(true);
    expect((await deliver(reset, "STAFF_INVITE")).success).toBe(true);
  });
});

describe("attempt-time recipient recheck and first-attempt anchor", () => {
  const guarded: RenderedEmail = {
    ...message,
    deliveryPolicy: { userId: "user-1", category: "appointments" },
  };
  const account = {
    email: "user@example.com",
    erasedAt: null,
    orgWorkspaceProfile: null,
    notificationPreferences: null,
  };

  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test";
    mockCreate.mockResolvedValue({ id: "fe-p" });
    mockUpdate.mockResolvedValue({});
    mockPolicyUser.mockResolvedValue(account);
    mockSend.mockResolvedValue({ data: { id: "re-p" }, error: null });
  });

  it("stores the account and category in typed columns and never sends them", async () => {
    const result = await deliver(guarded, "APPOINTMENT_BOOKED");

    expect(result.success).toBe(true);
    expect(mockCreate.mock.calls[0][0].data).toMatchObject({
      deliveryUserId: "user-1",
      deliveryCategory: "appointments",
    });
    expect(mockPolicyUser).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "user-1" } }),
    );
    expect(mockSend.mock.calls[0][0]).not.toHaveProperty("deliveryPolicy");
  });

  it("stores null columns for direct-address mail and reads no account", async () => {
    await deliver(message, "CONTACT_INQUIRY");

    expect(mockCreate.mock.calls[0][0].data).toMatchObject({
      deliveryUserId: null,
      deliveryCategory: null,
    });
    expect(mockPolicyUser).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("stamps firstAttemptAt once, only while unset, before the provider call", async () => {
    const order: string[] = [];
    mockUpdateMany.mockImplementation(async () => {
      order.push("stamp");
      return { count: 1 };
    });
    mockSend.mockImplementation(async () => {
      order.push("send");
      return { data: { id: "re-p" }, error: null };
    });

    await deliver(guarded, "APPOINTMENT_BOOKED");

    expect(order).toEqual(["stamp", "send"]);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "fe-p", firstAttemptAt: null },
      data: { firstAttemptAt: expect.any(Date) },
    });
  });

  it.each([
    [{ ...account, email: "changed@example.com" }, "policy:recipient_changed"],
    [{ ...account, erasedAt: new Date() }, "policy:recipient_erased"],
    [
      {
        ...account,
        orgWorkspaceProfile: { notificationRoutingMode: "BELL_ONLY" },
      },
      "policy:preference_changed",
    ],
  ])(
    "dead-letters a staged row whose account no longer accepts it (%#)",
    async (user, lastError) => {
      const staged = await stage(guarded, "APPOINTMENT_BOOKED");
      mockPolicyUser.mockResolvedValue(user);

      const result = await attempt(staged, guarded, "APPOINTMENT_BOOKED", {
        budgetMs: 1_000,
      });

      expect(result.success).toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
      expect(mockUpdateMany).not.toHaveBeenCalled();
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: "fe-p" },
        data: { status: "DEAD_LETTER", lastError },
      });
      expect(mockCaptureException).not.toHaveBeenCalled();
    },
  );

  it("dead-letters a row suppressed after staging, right before the send", async () => {
    const staged = await stage(guarded, "APPOINTMENT_BOOKED");
    mockFindSuppression.mockResolvedValue({
      email: "user@example.com",
      reason: "COMPLAINT",
    });

    await attempt(staged, guarded, "APPOINTMENT_BOOKED", { budgetMs: 1_000 });

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "fe-p" },
      data: { status: "DEAD_LETTER", lastError: "suppressed:COMPLAINT" },
    });
  });

  it("leaves the row pending and sends nothing when the account cannot be read", async () => {
    const staged = await stage(guarded, "APPOINTMENT_BOOKED");
    mockPolicyUser.mockRejectedValueOnce(new Error("pool unavailable"));

    const result = await attempt(staged, guarded, "APPOINTMENT_BOOKED", {
      budgetMs: 1_000,
    });

    expect(result).toMatchObject({ success: false, staged: true });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
    const data = mockUpdate.mock.calls[0][0].data;
    expect(data.status).toBeUndefined();
    expect(data.lastError).toContain("pool unavailable");
  });

  it("persists an unstaged message with its policy when the recheck cannot read", async () => {
    mockPolicyUser.mockRejectedValueOnce(new Error("pool unavailable"));

    await attempt(null, guarded, "APPOINTMENT_BOOKED", { budgetMs: 1_000 });

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockCreate.mock.calls[0][0].data).toMatchObject({
      status: "PENDING",
      deliveryUserId: "user-1",
      deliveryCategory: "appointments",
    });
  });
});
