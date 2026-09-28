/**
 * #1861 S4 — headers and nested-key redaction the Sentry event scrubber
 * applies on top of the existing beforeSend relabel/throttle.
 */
import {
  scrubSentryBreadcrumb,
  scrubSentryEvent,
} from "../../lib/observability/sentry-scrubber";
import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";

describe("scrubSentryEvent", () => {
  test("redacts sensitive headers, drops cookies, redacts nested keys by name", () => {
    const event: ErrorEvent = {
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
    expect((scrubbed.extra?.payload as Record<string, unknown>).accountNumber).toBe(
      "[redacted]",
    );
    expect((scrubbed.extra?.payload as Record<string, unknown>).note).toBe("fine");
  });
});

describe("scrubSentryBreadcrumb", () => {
  test("strips token/secret/signature query params on http breadcrumbs only", () => {
    const http: Breadcrumb = {
      category: "http",
      data: { url: "https://api.example.com/pay?token=xyz&keep=1" },
    };
    const other: Breadcrumb = { category: "ui.click", data: { url: "irrelevant?token=xyz" } };

    expect((scrubSentryBreadcrumb(http).data as { url: string }).url).toBe(
      "https://api.example.com/pay?token=%5Bredacted%5D&keep=1",
    );
    expect((scrubSentryBreadcrumb(other).data as { url: string }).url).toBe(
      "irrelevant?token=xyz",
    );
  });
});
