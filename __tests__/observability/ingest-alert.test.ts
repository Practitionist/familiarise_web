/**
 * @jest-environment node
 *
 * The canary pages outside Sentry: an email through `deliver()` and an
 * error-level Better Stack line, with a remedy chosen per verdict.
 */

jest.mock("../../lib/email/deliver", () => ({
  deliver: jest.fn(async () => ({ success: true, data: {}, staged: true })),
}));
jest.mock("../../lib/observability/betterstack-telemetry", () => ({
  emitTelemetryLog: jest.fn(async () => undefined),
}));
jest.mock("../../lib/observability/ops-chat", () => ({
  postOpsChat: jest.fn(async () => false),
}));

import { deliver } from "../../lib/email/deliver";
import { emitTelemetryLog } from "../../lib/observability/betterstack-telemetry";
import {
  buildAlertEmail,
  canaryAlertRecipient,
  sendSentryIngestAlert,
} from "../../lib/observability/ingest-alert";
import type { IngestCheck } from "../../lib/observability/ingest-canary";

const QUOTA: IngestCheck = {
  verdict: "rejecting",
  accepted: 4,
  rejections: [
    { outcome: "rate_limited", reason: "error_usage_exceeded", count: 120 },
  ],
  detail: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.OBSERVABILITY_ALERT_EMAIL;
});

it("emails the ops override and logs an error line for Better Stack", async () => {
  process.env.OBSERVABILITY_ALERT_EMAIL = "ops@example.test";
  await expect(sendSentryIngestAlert(QUOTA)).resolves.toBe(true);

  const [message, emailType] = (deliver as jest.Mock).mock.calls[0];
  expect((message as { to: string }).to).toBe("ops@example.test");
  expect(emailType).toBe("sentry-ingest-canary");
  expect(emitTelemetryLog).toHaveBeenCalledWith(
    expect.objectContaining({
      level: "error",
      message: "sentry-ingest-canary unhealthy",
    }),
  );
});

it("gives a quota remedy only for a spent allowance, and none for a bad read", () => {
  expect(buildAlertEmail(QUOTA).text).toContain("allowance");
  const throttle = buildAlertEmail({
    ...QUOTA,
    rejections: [
      { outcome: "rate_limited", reason: "smart_rate_limit", count: 3 },
    ],
  });
  expect(throttle.text).toContain("do not buy a plan");
  const unreadable = buildAlertEmail({
    verdict: "stats-unreadable",
    accepted: 0,
    rejections: [],
    detail: "<b>timeout</b>",
  });
  expect(unreadable.subject).toContain("ingest health unknown");
  expect(unreadable.text).toContain("SENTRY_STATS_TOKEN");
  expect(unreadable.html).toContain("&lt;b&gt;timeout");
  expect(canaryAlertRecipient()).toContain("@");
});
