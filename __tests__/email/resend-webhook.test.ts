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
const mockWaitlistUpdateMany = jest.fn();

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({
    webhooks: { verify: (...args: unknown[]) => mockVerify(...args) },
  })),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    emailEvent: { create: (...args: unknown[]) => mockEventCreate(...args) },
    emailSuppression: {
      upsert: (...args: unknown[]) => mockSuppressionUpsert(...args),
    },
    waitlist: {
      updateMany: (...args: unknown[]) => mockWaitlistUpdateMany(...args),
    },
  },
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
  mockWaitlistUpdateMany.mockResolvedValue({ count: 1 });
});
afterEach(() => jest.clearAllMocks());

describe("POST /api/webhooks/resend (#1647)", () => {
  it("answers 401 and stores nothing when the signature does not verify", async () => {
    mockVerify.mockImplementation(() => {
      throw new Error("No matching signature found");
    });

    const res = await POST(request(event("email.delivered")));

    expect(res.status).toBe(401);
    expect(mockEventCreate).not.toHaveBeenCalled();
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

  it("suppresses a Permanent bounce as HARD_BOUNCE and marks the Waitlist row BOUNCED", async () => {
    const payload = event("email.bounced", {
      bounce: { type: "Permanent", subType: "General", message: "gone" },
    });
    mockVerify.mockReturnValue(payload);

    const res = await POST(request(payload));

    expect(res.status).toBe(200);
    expect(mockEventCreate.mock.calls[0][0].data).toMatchObject({
      svixId: "msg_1",
      resendId: "re-1",
      type: "email.bounced",
      recipient: "bouncy@example.com",
    });
    expect(mockSuppressionUpsert).toHaveBeenCalledWith({
      where: { email: "bouncy@example.com" },
      create: {
        email: "bouncy@example.com",
        reason: "HARD_BOUNCE",
        sourceEventId: "ev-1",
      },
      update: {},
    });
    expect(mockWaitlistUpdateMany).toHaveBeenCalledWith({
      where: {
        email: "bouncy@example.com",
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
});
