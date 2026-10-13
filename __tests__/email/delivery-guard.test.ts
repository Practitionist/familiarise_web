/**
 * @jest-environment node
 */

// Pre-launch guard: only our own domain and EMAIL_ALLOWLIST receive mail until
// EMAIL_DELIVERY_MODE=live, and a held message is terminal in the outbox.

const mockSend = jest.fn();
const mockCreate = jest.fn();
const mockFindSuppression = jest.fn();

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
      update: jest.fn(),
    },
    emailSuppression: {
      findUnique: (...args: unknown[]) => mockFindSuppression(...args),
    },
  },
}));

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import type { FailedEmail, Prisma } from "@prisma/client";
import { deliver } from "@/lib/email/deliver";
import {
  EmailHeldError,
  HELD_PRE_LAUNCH,
  heldRecipientDomain,
} from "@/lib/email/delivery-guard";
import {
  runEmailRetryTick,
  type FailedEmailStore,
  type RelaySender,
} from "@/jobs/email/retry-failed-emails";

const message = {
  from: "Familiarise <onboarding@mail.familiarisenow.com>",
  to: "seeded.user@gmail.com",
  subject: "Welcome",
  html: "<p>hi</p>",
};

const OLD_KEY = process.env.RESEND_API_KEY;
beforeEach(() => {
  delete process.env.EMAIL_DELIVERY_MODE;
  delete process.env.EMAIL_ALLOWLIST;
  process.env.RESEND_API_KEY = "re_test";
  jest.spyOn(console, "info").mockImplementation(() => {});
  mockCreate.mockResolvedValue({ id: "fe-1" });
  mockFindSuppression.mockResolvedValue(null);
  mockSend.mockResolvedValue({ data: { id: "re-1" }, error: null });
});
afterEach(() => {
  process.env.EMAIL_DELIVERY_MODE = "live";
  if (OLD_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = OLD_KEY;
  jest.clearAllMocks();
});

describe("pre-launch delivery guard", () => {
  it("holds a seeded @gmail.com recipient when the mode is unset", async () => {
    const result = await deliver(message, "WELCOME");

    expect(mockSend).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, staged: true });
    expect((result as { error: unknown }).error).toBeInstanceOf(EmailHeldError);
    expect(mockCreate.mock.calls[0][0].data).toMatchObject({
      status: "DEAD_LETTER",
      lastError: HELD_PRE_LAUNCH,
    });
  });

  it("decides per recipient: own domain, allowlist entries, mixed and live", () => {
    expect(heldRecipientDomain("ops@familiarisenow.com")).toBeNull();
    expect(heldRecipientDomain("Ops <x@mail.familiarisenow.com>")).toBeNull();
    process.env.EMAIL_ALLOWLIST = " Owner@Gmail.com , @partner.test ";
    expect(heldRecipientDomain("owner@gmail.com")).toBeNull();
    expect(heldRecipientDomain("anyone@partner.test")).toBeNull();
    expect(heldRecipientDomain("other@gmail.com")).toBe("gmail.com");
    expect(
      heldRecipientDomain(["owner@gmail.com", "stranger@outlook.com"]),
    ).toBe("outlook.com");
    expect(heldRecipientDomain("a@evilfamiliarisenow.com")).toBe(
      "evilfamiliarisenow.com",
    );
    expect(heldRecipientDomain("a@familiarisenow.com.evil.com")).toBe(
      "familiarisenow.com.evil.com",
    );
    expect(heldRecipientDomain("x@gmail.com, ops@familiarisenow.com")).toBe(
      "(invalid)",
    );
    process.env.EMAIL_ALLOWLIST = "tester.test";
    expect(heldRecipientDomain("a@tester.test")).toBeNull();
    process.env.EMAIL_DELIVERY_MODE = "live";
    expect(heldRecipientDomain("stranger@outlook.com")).toBeNull();
  });

  it("sends an own-domain recipient, and anyone in live mode", async () => {
    await deliver({ ...message, to: "ops@familiarisenow.com" }, "ALERT");
    process.env.EMAIL_DELIVERY_MODE = "live";
    await deliver(message, "WELCOME");
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("holds when an allowed to carries a refused bcc", async () => {
    const withBcc = {
      ...message,
      to: "ops@familiarisenow.com",
      bcc: ["seeded.user@gmail.com"],
    };
    const result = await deliver(withBcc, "ALERT");
    expect(mockSend).not.toHaveBeenCalled();
    expect((result as { error: unknown }).error).toBeInstanceOf(EmailHeldError);
  });

  it("dead-letters a held outbox row instead of retrying it", async () => {
    const updates: Prisma.FailedEmailUpdateArgs[] = [];
    const row = {
      id: "fe-9",
      recipient: "seeded.user@yahoo.com",
      emailType: "WELCOME",
      status: "PENDING",
    } as FailedEmail;
    const store: FailedEmailStore = {
      failedEmail: {
        findMany: jest.fn().mockResolvedValue([row]),
        update: jest.fn(async (args: Prisma.FailedEmailUpdateArgs) => {
          updates.push(args);
          return row;
        }),
      },
      emailSuppression: { findMany: jest.fn().mockResolvedValue([]) },
      failedEmailBatch: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
      },
    };
    const send = jest.fn();
    const sender = {
      emails: { send },
      batch: { send },
    } as unknown as RelaySender;

    const result = await runEmailRetryTick({ prisma: store, resend: sender });

    expect(send).not.toHaveBeenCalled();
    expect(result.deadLettered).toBe(1);
    expect(updates[0].data).toEqual({
      status: "DEAD_LETTER",
      lastError: HELD_PRE_LAUNCH,
    });
  });
});
