/**
 * #1861 S4 — headers and nested-key redaction the Sentry event scrubber
 * applies on top of the existing beforeSend relabel/throttle.
 */
import {
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubSentryLog,
  scrubSentrySpan,
} from "../../lib/observability/sentry-scrubber";
import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";

describe("scrubSentryEvent", () => {
  test("redacts sensitive headers, drops cookies, redacts nested keys by name", () => {
    const event: ErrorEvent = {
      type: undefined,
      request: {
        headers: {
          Authorization: "Bearer secret-token",
          "x-razorpay-signature": "abc",
          "x-request-id": "keep-me",
        },
        cookies: { session: "abc123" },
        data: { cardNumber: "4111111111111111", orderId: "order_123" },
      },
      extra: {
        payload: { accountNumber: "0011223344", note: "fine" },
      },
    };

    const scrubbed = scrubSentryEvent(event);

    expect(scrubbed.request?.headers).toEqual({
      Authorization: "[redacted]",
      "x-razorpay-signature": "[redacted]",
      "x-request-id": "keep-me",
    });
    expect(scrubbed.request?.cookies).toBeUndefined();
    expect(scrubbed.request?.data).toEqual({
      cardNumber: "[redacted]",
      orderId: "order_123",
    });
    expect(
      (scrubbed.extra?.payload as Record<string, unknown>).accountNumber,
    ).toBe("[redacted]");
    expect((scrubbed.extra?.payload as Record<string, unknown>).note).toBe(
      "fine",
    );
  });

  test("redacts PAN only as a whole word", () => {
    const scrubbed = scrubSentryEvent({
      type: undefined,
      extra: {
        panNumber: "ABCDE1234F",
        pan_last4: "234F",
        companyName: "Acme",
        participantId: "p1",
      },
    });
    expect(scrubbed.extra).toEqual({
      panNumber: "[redacted]",
      pan_last4: "[redacted]",
      companyName: "Acme",
      participantId: "p1",
    });
  });

  test("strips tokens from the request URL and query string", () => {
    const scrubbed = scrubSentryEvent({
      type: undefined,
      request: {
        url: "https://familiarisenow.com/invite/accept?token=abc&org=o1",
        query_string: "token=abc&org=o1",
      },
    });
    expect(scrubbed.request?.url).toBe(
      "https://familiarisenow.com/invite/accept?token=%5Bredacted%5D&org=o1",
    );
    expect(scrubbed.request?.query_string).toBe("token=%5Bredacted%5D&org=o1");
  });

  test("scrubs email addresses, Bearer tokens, and SDK Error body/rawValue properties (#1876, #1926)", () => {
    const sdkError = Object.assign(
      new Error("Novu failed for victim@example.com with Bearer tok_secret_1"),
      {
        statusCode: 422,
        body: '{"subscriber":{"email":"victim@example.com"}}',
        rawValue: { subscriber: { email: "victim@example.com" } },
      },
    );
    const scrubbed = scrubSentryEvent({
      type: undefined,
      message: "Auth failed for user@example.com (Bearer eyJhbGciOi)",
      exception: {
        values: [
          {
            type: "NovuError",
            value: "Rejected subscriber user@example.com",
          },
        ],
      },
      extra: {
        thrown: sdkError,
        rawStringBody: "contact a@b.co with ?token=secret123",
      },
    });

    expect(scrubbed.message).toBe(
      "Auth failed for [REDACTED_EMAIL] (Bearer [REDACTED])",
    );
    expect(scrubbed.exception?.values?.[0]?.value).toBe(
      "Rejected subscriber [REDACTED_EMAIL]",
    );
    const scrubbedThrown = scrubbed.extra?.thrown as Error & {
      statusCode?: number;
      body?: string;
      rawValue?: unknown;
    };
    expect(scrubbedThrown.message).toBe(
      "Novu failed for [REDACTED_EMAIL] with Bearer [REDACTED]",
    );
    expect(scrubbedThrown.statusCode).toBe(422);
    expect(scrubbedThrown.body).toBe("[redacted]");
    expect(scrubbedThrown.rawValue).toBe("[redacted]");
    expect(scrubbed.extra?.rawStringBody).toBe(
      "contact [REDACTED_EMAIL] with ?token=[redacted]",
    );
  });
});

describe("scrubSentryBreadcrumb", () => {
  test("strips token/secret/signature query params on http breadcrumbs only and scrubs messages across categories", () => {
    const http: Breadcrumb = {
      category: "http",
      data: { url: "https://api.example.com/pay?token=xyz&keep=1" },
    };
    const other: Breadcrumb = {
      category: "ui.click",
      message: "Clicked reset for alice@example.com",
      data: { url: "irrelevant?token=xyz" },
    };

    expect((scrubSentryBreadcrumb(http).data as { url: string }).url).toBe(
      "https://api.example.com/pay?token=%5Bredacted%5D&keep=1",
    );
    const scrubbedOther = scrubSentryBreadcrumb(other);
    expect((scrubbedOther.data as { url: string }).url).toBe(
      "irrelevant?token=xyz",
    );
    expect(scrubbedOther.message).toBe("Clicked reset for [REDACTED_EMAIL]");
  });
});

describe("scrubSentrySpan (#1916, #1926)", () => {
  test("strips culture.timezone and scrubs sensitive data and descriptions on spans", () => {
    const span = {
      span_id: "s1",
      trace_id: "t1",
      start_timestamp: 1,
      description:
        "GET https://familiarisenow.com/api/verify?token=sec123&user=bob@example.com",
      data: {
        "culture.timezone": "Asia/Kolkata",
        "http.query": "token=sec123",
        apiKey: "secret-key",
        safeAttr: "ok",
      },
      contexts: {
        culture: {
          locale: "en-IN",
          timezone: "Asia/Kolkata",
        },
      },
    };

    const scrubbed = scrubSentrySpan(
      span as unknown as Parameters<typeof scrubSentrySpan>[0],
    ) as typeof span;

    expect(scrubbed.description).toContain("token=%5Bredacted%5D");
    expect(scrubbed.description).not.toContain("bob@example.com");
    expect(scrubbed.data).toEqual({
      "http.query": "token=%5Bredacted%5D",
      apiKey: "[redacted]",
      safeAttr: "ok",
    });
    expect(scrubbed.contexts.culture).toEqual({ locale: "en-IN" });
  });
});

describe("scrubSentryLog (#1926)", () => {
  test("scrubs PII from log message and attributes", () => {
    const log = {
      level: "info" as const,
      message: "Sent invite to member@example.com with Bearer tok_123",
      attributes: {
        recipientEmail: "member@example.com",
        clientSecret: "shh",
        workflowId: "appointment-booked",
      },
    };

    const scrubbed = scrubSentryLog(log);
    expect(scrubbed).not.toBeNull();
    expect(scrubbed?.message).toBe(
      "Sent invite to [REDACTED_EMAIL] with Bearer [REDACTED]",
    );
    expect(scrubbed?.attributes).toEqual({
      recipientEmail: "[REDACTED_EMAIL]",
      clientSecret: "[redacted]",
      workflowId: "appointment-booked",
    });
  });
});
