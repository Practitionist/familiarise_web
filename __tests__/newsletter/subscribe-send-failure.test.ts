/**
 * @jest-environment node
 */

/**
 * A signup writes the row first and sends the confirmation second. When the
 * send fails the row is already on the list, so the caller must be told —
 * silently reporting success strands the subscriber at PENDING with no
 * confirmation link to click.
 *
 * A signing failure inside `buildConfirmUrl` must come back as a failed send,
 * never a throw out of `subscribe()` after the row was written.
 */

const mockUpsert = jest.fn();
const mockFindUnique = jest.fn();
const mockSendConfirm = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    newsletterSubscriber: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
    },
  },
}));

jest.mock("../../lib/email", () => ({
  __esModule: true,
  sendNewsletterConfirmEmail: (...args: unknown[]) => mockSendConfirm(...args),
  sendNewsletterWelcomeEmail: jest.fn(),
}));

const mockCaptureMessage = jest.fn();
const mockCaptureException = jest.fn();

jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));
jest.mock("@sentry/nextjs", () => ({
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

jest.mock("../../lib/auth/link-signing", () => ({
  canSignLinks: () => true,
  deriveAuthKey: () => Buffer.from("test-key"),
}));
jest.mock("../../lib/newsletter/tokens", () => ({
  verifyConfirmToken: jest.fn(),
  verifyUnsubscribeToken: jest.fn(),
}));

import { subscribe } from "../../lib/newsletter/service";

const input = { email: "Reader@Example.com ", source: "FOOTER" as never };

describe("subscribe — confirmation send failure", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindUnique.mockResolvedValue(null);
    mockUpsert.mockResolvedValue({});
  });

  it("reports CONFIRMATION_FAILED when the send fails, and still writes the row", async () => {
    mockSendConfirm.mockResolvedValue({ success: false, error: "no secret" });

    const result = await subscribe(input);

    expect(result).toEqual({ outcome: "CONFIRMATION_FAILED" });
    // The row must still be on the list — the address opted in.
    expect(mockUpsert).toHaveBeenCalledTimes(1);

    // Removing the reporting call must fail this test, not pass silently.
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining("newsletter confirmation email failed to send"),
      expect.objectContaining({
        level: "warning",
        tags: { subsystem: "newsletter" },
      }),
    );
    // Neither the address nor a signed link may reach the report.
    const reported = JSON.stringify(mockCaptureMessage.mock.calls);
    expect(reported).not.toContain("reader@example.com");
    expect(reported).not.toContain("token=");
  });

  it("does not throw when the sender reports failure", async () => {
    mockSendConfirm.mockResolvedValue({ success: false, error: "no secret" });
    await expect(subscribe(input)).resolves.toBeDefined();
  });

  it("reports CONFIRMATION_SENT on a successful send", async () => {
    mockSendConfirm.mockResolvedValue({ success: true, data: {} });

    await expect(subscribe(input)).resolves.toEqual({
      outcome: "CONFIRMATION_SENT",
    });
  });

  it("normalises the address before writing and sending", async () => {
    mockSendConfirm.mockResolvedValue({ success: true, data: {} });

    await subscribe(input);

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "reader@example.com" } }),
    );
    expect(mockSendConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ email: "reader@example.com" }),
    );
  });

  it("short-circuits an already-subscribed address without sending", async () => {
    mockFindUnique.mockResolvedValue({ status: "SUBSCRIBED" });

    await expect(subscribe(input)).resolves.toEqual({
      outcome: "ALREADY_SUBSCRIBED",
    });
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockSendConfirm).not.toHaveBeenCalled();
  });
});

describe("subscribe — linking the signed-in account", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindUnique.mockResolvedValue(null);
    mockUpsert.mockResolvedValue({});
    mockSendConfirm.mockResolvedValue({ success: true, data: {} });
  });

  const linked = () => mockUpsert.mock.calls[0][0].create.userId;

  it("links the session only when its verified email is the submitted one", async () => {
    await subscribe({
      ...input,
      sessionUser: {
        id: "u1",
        email: "READER@example.com",
        emailVerified: true,
      },
    });
    expect(linked()).toBe("u1");
  });

  it("never links a session to another address, or an unverified one", async () => {
    await subscribe({
      ...input,
      sessionUser: {
        id: "u1",
        email: "other@example.com",
        emailVerified: true,
      },
    });
    await subscribe({
      ...input,
      sessionUser: {
        id: "u1",
        email: "reader@example.com",
        emailVerified: false,
      },
    });
    expect(mockUpsert.mock.calls.map(([args]) => args.create.userId)).toEqual([
      null,
      null,
    ]);
  });
});
