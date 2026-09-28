/**
 * @jest-environment node
 *
 * `lib/observability/ingest-alert` — the alert that has to survive Sentry.
 *
 * Two properties matter and neither is obvious from the call site: the message
 * must carry the remedy, because the reader is looking at a dashboard that
 * looks healthy and has no way to derive the fix; and the recipient must be
 * overridable, because the default is a customer-facing support mailbox and an
 * ops alert landing in an inbox that is not watched is the same failure mode
 * one layer up.
 */

jest.mock("../../lib/email/deliver", () => ({
  deliver: jest.fn(async () => ({ success: true, data: {}, staged: true })),
}));

import { deliver } from "../../lib/email/deliver";
import {
  buildAlertEmail,
  canaryAlertRecipient,
  sendSentryIngestAlert,
} from "../../lib/observability/ingest-alert";
import type { IngestProbeResult } from "../../lib/observability/ingest-canary";

const RATE_LIMITED: IngestProbeResult = {
  verdict: "rate-limited",
  status: 429,
  detail:
    "Sentry dropped data due to a quota or internal rate limit being reached.",
  rateLimits:
    "60:default;error;security;attachment:organization:error_usage_exceeded",
  eventId: "a".repeat(32),
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.OBSERVABILITY_ALERT_EMAIL;
});

describe("buildAlertEmail", () => {
  it("names the verdict and the reason in the subject", () => {
    expect(buildAlertEmail(RATE_LIMITED).subject).toContain("rate-limited");
    expect(buildAlertEmail(RATE_LIMITED).subject).toContain("being discarded");
  });

  // The reader cannot derive this: their dashboard is empty and looks healthy.
  it("carries the rate-limit header and the remedy", () => {
    const { text } = buildAlertEmail(RATE_LIMITED);
    expect(text).toContain("error_usage_exceeded");
    expect(text).toContain("does not have to wait");
  });

  it("includes the event id so a run can be correlated", () => {
    expect(buildAlertEmail(RATE_LIMITED).text).toContain("a".repeat(32));
  });

  // Sentry's own strings go into an HTML email, so they are escaped.
  it("escapes HTML in the values it interpolates", () => {
    const { html } = buildAlertEmail({
      ...RATE_LIMITED,
      detail: "<img src=x onerror=alert(1)>",
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

describe("canaryAlertRecipient", () => {
  it("prefers the ops override", () => {
    process.env.OBSERVABILITY_ALERT_EMAIL = "ops@example.test";
    expect(canaryAlertRecipient()).toBe("ops@example.test");
  });

  it("falls back to a non-empty address rather than sending nowhere", () => {
    const to = canaryAlertRecipient();
    expect(to).toContain("@");
  });
});

describe("sendSentryIngestAlert", () => {
  it("sends to the ops override and reports success", async () => {
    process.env.OBSERVABILITY_ALERT_EMAIL = "ops@example.test";
    await expect(sendSentryIngestAlert(RATE_LIMITED)).resolves.toBe(true);

    expect(deliver).toHaveBeenCalledTimes(1);
    const [message, emailType, opts] = (deliver as jest.Mock).mock.calls[0];
    expect((message as { to: string }).to).toBe("ops@example.test");
    expect(emailType).toBe("sentry-ingest-canary");
    // The dead-letter row has to point back at the probe that raised it.
    expect((opts as { entityRef: string }).entityRef).toContain(
      RATE_LIMITED.eventId,
    );
  });

  it("reports false when the provider rejects it, so the caller can log that", async () => {
    (deliver as jest.Mock).mockResolvedValueOnce({
      success: false,
      error: new Error("resend down"),
    });
    await expect(sendSentryIngestAlert(RATE_LIMITED)).resolves.toBe(false);
  });
});
