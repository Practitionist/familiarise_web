/**
 * @jest-environment node
 */

/**
 * #1459 — the Razorpay webhook route is unauthenticated until the HMAC is
 * checked, and checking the HMAC means reading the whole body into a buffer. A
 * real Razorpay event is a few kilobytes, so an oversized body is never a
 * delivery we owe service to; refusing it before the signature read is what
 * keeps a stranger from choosing how much memory the route allocates. The
 * refusal has to come first in the handler for that to hold, which is what this
 * pins: the signature verifier is never reached and no inbox row is written.
 */

jest.mock("@sentry/nextjs", () => ({
  setTag: jest.fn(),
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../app/api/webhooks/utils", () => ({
  verifyWebhookSignature: jest.fn(),
  logWebhookEvent: jest.fn(),
  isDbHealthy: jest.fn(),
}));

jest.mock("../../app/api/webhooks/razorpay-dispatch", () => ({
  processRazorpayWebhookEvent: jest.fn(),
}));

jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemEvent: jest.fn(),
}));

import type { NextRequest } from "next/server";

import { POST } from "../../app/api/webhooks/razorpay/route";
import {
  logWebhookEvent,
  verifyWebhookSignature,
} from "../../app/api/webhooks/utils";

function requestOfDeclaredSize(bytes: number): NextRequest {
  const headers = new Headers({ "content-length": String(bytes) });
  return { headers } as unknown as NextRequest;
}

describe("Razorpay webhook body cap (#1459)", () => {
  it("refuses a body over 256 KB with 413, before the signature read", async () => {
    const res = await POST(requestOfDeclaredSize(512 * 1024));

    expect(res.status).toBe(413);
    expect(verifyWebhookSignature).not.toHaveBeenCalled();
    expect(logWebhookEvent).not.toHaveBeenCalled();
  });
});
