/**
 * A fault is captured once: reporting the same error again, or an error that
 * wraps it as `cause`, answers with the first event id and sends nothing.
 */

let next = 0;
const captureException = jest.fn(() => `evt-${++next}`);
jest.mock("@sentry/core", () => ({
  captureException: (...args: unknown[]) => captureException(...(args as [])),
  captureMessage: jest.fn(),
}));

import { reportSentryError } from "../../lib/observability/report";

beforeEach(() => {
  captureException.mockClear();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

it("captures a rethrown fault once and returns its first id", () => {
  const fault = new Error("expired transaction");
  const first = reportSentryError(fault, { subsystem: "payments" });
  expect(reportSentryError(fault, { subsystem: "checkout" })).toBe(first);
  const wrapper = new Error("Failed to record payment information.", {
    cause: fault,
  });
  expect(reportSentryError(wrapper, { subsystem: "checkout" })).toBe(first);
  expect(captureException).toHaveBeenCalledTimes(1);
});

it("still reports as a fault an error first reported as expected", () => {
  const refusal = new Error("slot taken");
  reportSentryError(refusal, { subsystem: "payments", expected: true });
  const fault = reportSentryError(refusal, { subsystem: "checkout" });
  expect(captureException).toHaveBeenCalledTimes(2);
  expect(reportSentryError(refusal, { subsystem: "api" })).toBe(fault);
});
