/** @jest-environment node */

const mockRun = jest.fn();
jest.mock("../../lib/redis", () => ({
  createCircuitBreaker: () => ({
    run: (...args: unknown[]) => mockRun(...args),
  }),
}));
jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import * as Sentry from "@sentry/nextjs";
import { withStreamCircuitBreaker } from "../../lib/stream-client";
import type { RunFailureReporter } from "../../lib/observability/run-failures";

beforeEach(() => {
  jest.clearAllMocks();
  mockRun.mockImplementation((operation: () => Promise<unknown>) =>
    operation(),
  );
});

it.each([
  new Error("transport unavailable"),
  Object.assign(new Error("billing refused"), { code: 99 }),
  new Error("circuit breaker is OPEN"),
])(
  "delegates %s to the invocation reporter without a direct capture",
  async (error) => {
    const reporter: RunFailureReporter = { add: jest.fn(), flush: jest.fn() };
    await expect(
      withStreamCircuitBreaker(
        async () => {
          throw error;
        },
        undefined,
        reporter,
      ),
    ).rejects.toThrow();
    expect(reporter.add).toHaveBeenCalledTimes(1);
    expect(reporter.flush).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  },
);

it("preserves direct reporting for callers without an invocation reporter", async () => {
  const error = new Error("transport unavailable");
  await expect(
    withStreamCircuitBreaker(async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(Sentry.captureException).toHaveBeenCalledTimes(1);
});

it.each([404, 429])(
  "keeps expected HTTP %s out of both reporting paths",
  async (status) => {
    const reporter: RunFailureReporter = { add: jest.fn(), flush: jest.fn() };
    const error = Object.assign(new Error("expected refusal"), { status });
    await expect(
      withStreamCircuitBreaker(
        async () => {
          throw error;
        },
        undefined,
        reporter,
      ),
    ).rejects.toBe(error);
    expect(reporter.add).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  },
);

it("keeps the existing fallback behavior when the breaker is open", async () => {
  const reporter: RunFailureReporter = { add: jest.fn(), flush: jest.fn() };
  await expect(
    withStreamCircuitBreaker(
      async () => {
        throw new Error("circuit breaker is OPEN");
      },
      () => "cached",
      reporter,
    ),
  ).resolves.toBe("cached");
  expect(reporter.add).not.toHaveBeenCalled();
  expect(Sentry.captureException).not.toHaveBeenCalled();
});
