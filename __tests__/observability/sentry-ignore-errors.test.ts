/**
 * @jest-environment node
 */

// Invariant: a request whose router-state header is malformed answers 500 in
// Next but never opens a Sentry issue; any other error still reaches transport.

import type { ErrorEvent } from "@sentry/nextjs";

const sent: ErrorEvent[] = [];

jest.mock("@sentry/nextjs", () => {
  const actual = jest.requireActual("@sentry/nextjs");
  return {
    ...actual,
    init: (options: Record<string, unknown>) =>
      actual.init({
        ...options,
        transport: () => ({
          send: (envelope: unknown) => {
            const items = (envelope as unknown[])[1];
            if (Array.isArray(items)) {
              for (const item of items) {
                if (Array.isArray(item) && item[1])
                  sent.push(item[1] as ErrorEvent);
              }
            }
            return Promise.resolve({ status: "success" });
          },
          flush: () => Promise.resolve(true),
        }),
      }),
  };
});

import * as Sentry from "@sentry/nextjs";
import { initSentry } from "../../sentry.shared.config";

beforeAll(() => {
  process.env.NEXT_PUBLIC_SENTRY_DSN =
    "https://0000000000000000000000000000000@o0.ingest.sentry.io/0";
  process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "test";
  initSentry();
});

beforeEach(() => {
  sent.length = 0;
});

const messages = () =>
  sent.flatMap((e) => (e.exception?.values ?? []).map((v) => v.value));

it("drops the malformed router-state header error", async () => {
  Sentry.captureException(
    new Error("The router state header was sent but could not be parsed."),
  );
  await Sentry.flush(2000);
  expect(messages()).toEqual([]);
});

it("still sends an unrelated error", async () => {
  Sentry.captureException(new Error("router state is fine, this is a bug"));
  await Sentry.flush(2000);
  expect(messages()).toEqual(["router state is fine, this is a bug"]);
});
