/**
 * @jest-environment node
 */

/**
 * The webhook route's two unthrottled Sentry paths (secret unconfigured, receipt
 * write failing) report once per window, not once per delivery.
 */
import crypto from "node:crypto";
import { NextRequest } from "next/server";

const mockReport = jest.fn();
const mockCreate = jest.fn();

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...a: unknown[]) => mockReport(...a),
  reportSentryMessage: jest.fn(),
  errorMessageOf: (e: unknown) => String(e),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { webhookEvent: { create: (...a: unknown[]) => mockCreate(...a) } },
}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
jest.mock("../../lib/stream/recording-handlers", () => ({
  handleRecordingStarted: jest.fn(),
  handleRecordingStopped: jest.fn(),
  handleRecordingReady: jest.fn(),
  handleRecordingFailed: jest.fn(),
}));
jest.mock("../../lib/stream/session-handlers", () => ({
  handleSessionEnded: jest.fn(),
  handleCallEnded: jest.fn(),
  handleSessionParticipantJoined: jest.fn(),
  handleSessionParticipantLeft: jest.fn(),
}));

import { resetThrottledCaptureForTesting } from "../../lib/observability/throttled-capture";
import { POST } from "../../app/api/stream/webhooks/route";

const SECRET = "throttle-test-secret";

function signedRequest(): NextRequest {
  const body = Buffer.from(
    JSON.stringify({
      type: "call.recording_stopped",
      call_cid: "default:occurrence-1",
      created_at: new Date().toISOString(),
    }),
  );
  return new NextRequest("https://familiarise.com/api/stream/webhooks", {
    method: "POST",
    headers: {
      "x-signature": crypto
        .createHmac("sha256", SECRET)
        .update(body)
        .digest("hex"),
    },
    body: new Blob([Uint8Array.from(body)]),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetThrottledCaptureForTesting();
  delete process.env.NEXT_PUBLIC_STREAM_API_KEY;
  delete process.env.STREAM_WEBHOOK_SECRET_PREVIOUS;
});

describe("webhook route Sentry throttling", () => {
  it("reports an unconfigured secret once across repeated deliveries", async () => {
    delete process.env.STREAM_WEBHOOK_SECRET;
    delete process.env.STREAM_API_SECRET;

    for (let i = 0; i < 3; i++) {
      expect((await POST(signedRequest())).status).toBe(500);
    }

    expect(mockReport).toHaveBeenCalledTimes(1);
    expect(mockReport.mock.calls[0][1]).toMatchObject({
      subsystem: "stream",
      level: "fatal",
    });
  });

  it("reports a failing receipt write once while still answering 503 every time", async () => {
    process.env.STREAM_WEBHOOK_SECRET = SECRET;
    mockCreate.mockRejectedValue(new Error("db down"));

    for (let i = 0; i < 3; i++) {
      expect((await POST(signedRequest())).status).toBe(503);
    }

    expect(mockReport).toHaveBeenCalledTimes(1);
    expect(mockReport.mock.calls[0][1]).toMatchObject({
      subsystem: "stream",
      op: "webhook.receipt",
    });
  });
});
