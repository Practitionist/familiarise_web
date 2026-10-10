/**
 * @jest-environment node
 */

/**
 * #1647 — the Resend webhook receiver. Pins: an unverifiable signature stores
 * nothing, a redelivered svix id is a 200 no-op, a Permanent bounce and a
 * complaint suppress the address and settle its Waitlist row, and a Transient
 * bounce only stores the event.
 */

const mockVerify = jest.fn();
const mockEventCreate = jest.fn();
const mockSuppressionUpsert = jest.fn();
const mockSuppressionDeleteMany = jest.fn();
const mockWaitlistUpdateMany = jest.fn();
const mockRecordSystemErrorSafe = jest.fn();

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({
    webhooks: { verify: (...args: unknown[]) => mockVerify(...args) },
  })),
}));

jest.mock("../../lib/prisma", () => {
  const tx = {
    emailEvent: { create: (...args: unknown[]) => mockEventCreate(...args) },
    emailSuppression: {
      upsert: (...args: unknown[]) => mockSuppressionUpsert(...args),
      deleteMany: (...args: unknown[]) => mockSuppressionDeleteMany(...args),
    },
    waitlist: {
      updateMany: (...args: unknown[]) => mockWaitlistUpdateMany(...args),
    },
  };
  return {
    __esModule: true,
    default: {
      ...tx,
      $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) =>
        fn(tx),
      ),
    },
  };
});

jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemErrorSafe: (...args: unknown[]) =>
    mockRecordSystemErrorSafe(...args),
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/webhooks/resend/route";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/webhooks/resend", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "svix-id": "msg_1",
      "svix-timestamp": "1726400000",
      "svix-signature": "v1,abc",
    },
  });
}

function event(type: string, extra: Record<string, unknown> = {}) {
  return {
    type,
    created_at: "2026-09-15T10:00:00Z",
    data: {
      email_id: "re-1",
      to: ["Bouncy@Example.com"],
      from: "Familiarise <onboarding@mail.familiarisenow.com>",
      subject: "Hello",
      created_at: "2026-09-15T09:59:00Z",
      ...extra,
    },
  };
}

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test";
  process.env.RESEND_WEBHOOK_SECRET = "whsec_test";
  mockEventCreate.mockResolvedValue({ id: "ev-1" });
  mockSuppressionUpsert.mockResolvedValue({});
  mockSuppressionDeleteMany.mockResolvedValue({ count: 1 });
  mockWaitlistUpdateMany.mockResolvedValue({ count: 1 });
  mockRecordSystemErrorSafe.mockResolvedValue(undefined);
});
afterEach(() => jest.clearAllMocks());

describe("POST /api/webhooks/resend", () => {
  it("answers 401 and stores nothing when the signature does not verify", async () => {
    mockVerify.mockImplementation(() => {
      throw new Error("No matching signature found");
    });

    const res = await POST(request(event("email.delivered")));

    expect(res.status).toBe(401);
    expect(mockEventCreate).not.toHaveBeenCalled();
  });

  it("verifies and processes webhooks even when RESEND_API_KEY is unset", async () => {
    delete process.env.RESEND_API_KEY;
    const payload = event("email.delivered");
    mockVerify.mockReturnValue(payload);

    const res = await POST(request(payload));

    expect(res.status).toBe(200);
    expect(mockEventCreate).toHaveBeenCalledTimes(1);
  });

  it("answers 200 duplicate on a redelivered svix id without touching suppression", async () => {
    const payload = event("email.bounced", { bounce: { type: "Permanent" } });
    mockVerify.mockReturnValue(payload);
    mockEventCreate.mockRejectedValue({ code: "P2002" });

    const res = await POST(request(payload));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, duplicate: true });
    expect(mockSuppressionUpsert).not.toHaveBeenCalled();
    expect(mockWaitlistUpdateMany).not.toHaveBeenCalled();
  });

  it("returns 500 on transient DB errors inside transaction so Resend retries atomically", async () => {
    const payload = event("email.bounced", { bounce: { type: "Permanent" } });
    mockVerify.mockReturnValue(payload);
    mockSuppressionUpsert.mockRejectedValueOnce(new Error("deadlock detected"));

    const res = await POST(request(payload));

    expect(res.status).toBe(500);
  });

  it("suppresses all recipients of a multi-recipient Permanent bounce and updates Waitlist rows", async () => {
    const payload = event("email.bounced", {
      to: ["First@Example.com", "Second@Example.com"],
      bounce: { type: "Permanent", subType: "General", message: "gone" },
    });
    mockVerify.mockReturnValue(payload);

    const res = await POST(request(payload));

    expect(res.status).toBe(200);
    expect(mockEventCreate.mock.calls[0][0].data).toMatchObject({
      svixId: "msg_1",
      resendId: "re-1",
      type: "email.bounced",
      recipient: "first@example.com",
    });
    expect(mockSuppressionUpsert).toHaveBeenCalledTimes(2);
    expect(mockSuppressionUpsert).toHaveBeenCalledWith({
      where: { email: "first@example.com" },
      create: {
        email: "first@example.com",
        reason: "HARD_BOUNCE",
        sourceEventId: "ev-1",
      },
      update: {},
    });
    expect(mockSuppressionUpsert).toHaveBeenCalledWith({
      where: { email: "second@example.com" },
      create: {
        email: "second@example.com",
        reason: "HARD_BOUNCE",
        sourceEventId: "ev-1",
      },
      update: {},
    });
    expect(mockWaitlistUpdateMany).toHaveBeenCalledWith({
      where: {
        email: { in: ["first@example.com", "second@example.com"] },
        status: { in: ["PENDING", "SUBSCRIBED"] },
      },
      data: { status: "BOUNCED" },
    });
  });

  it("stores a Transient bounce as an event only", async () => {
    const payload = event("email.bounced", {
      bounce: { type: "Transient", subType: "MailboxFull", message: "full" },
    });
    mockVerify.mockReturnValue(payload);

    const res = await POST(request(payload));

    expect(res.status).toBe(200);
    expect(mockEventCreate).toHaveBeenCalledTimes(1);
    expect(mockSuppressionUpsert).not.toHaveBeenCalled();
    expect(mockWaitlistUpdateMany).not.toHaveBeenCalled();
  });

  it("suppresses a complaint as COMPLAINT and unsubscribes the Waitlist row", async () => {
    const payload = event("email.complained");
    mockVerify.mockReturnValue(payload);

    const res = await POST(request(payload));

    expect(res.status).toBe(200);
    expect(mockSuppressionUpsert.mock.calls[0][0].create).toMatchObject({
      reason: "COMPLAINT",
    });
    const update = mockWaitlistUpdateMany.mock.calls[0][0];
    expect(update.data.status).toBe("UNSUBSCRIBED");
    expect(update.data.unsubscribedAt).toBeInstanceOf(Date);
  });

  it("handles suppression.added and suppression.removed lifecycle events", async () => {
    const added = {
      type: "suppression.added",
      created_at: "2026-09-15T10:00:00Z",
      data: { email: "OptOut@Example.com", type: "manual" },
    };
    mockVerify.mockReturnValue(added);
    const resAdded = await POST(request(added));
    expect(resAdded.status).toBe(200);
    expect(mockSuppressionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: "optout@example.com" },
      }),
    );

    jest.clearAllMocks();
    mockEventCreate.mockResolvedValue({ id: "ev-2" });
    mockSuppressionDeleteMany.mockResolvedValue({ count: 1 });

    const removed = {
      type: "suppression.removed",
      created_at: "2026-09-15T10:01:00Z",
      data: { email: "OptOut@Example.com" },
    };
    mockVerify.mockReturnValue(removed);
    const resRemoved = await POST(request(removed));
    expect(resRemoved.status).toBe(200);
    expect(mockSuppressionDeleteMany).toHaveBeenCalledWith({
      where: { email: "optout@example.com" },
    });
  });

  it("handles contact.updated (unsubscribed) and degraded domain.updated events", async () => {
    const contactUnsub = {
      type: "contact.updated",
      created_at: "2026-09-15T10:00:00Z",
      data: { email: "Unsub@Example.com", unsubscribed: true },
    };
    mockVerify.mockReturnValue(contactUnsub);
    const resContact = await POST(request(contactUnsub));
    expect(resContact.status).toBe(200);
    expect(mockSuppressionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "unsub@example.com" } }),
    );
    expect(mockWaitlistUpdateMany).toHaveBeenCalled();

    const domainDegraded = {
      type: "domain.updated",
      created_at: "2026-09-15T10:05:00Z",
      data: { name: "mail.familiarisenow.com", status: "failed" },
    };
    mockVerify.mockReturnValue(domainDegraded);
    const resDomain = await POST(request(domainDegraded));
    expect(resDomain.status).toBe(200);
    expect(mockRecordSystemErrorSafe).toHaveBeenCalled();
  });
});
