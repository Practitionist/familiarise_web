const reportSentryError = jest.fn();
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...a: unknown[]) => reportSentryError(...a),
}));

import { createRunFailureReporter } from "../../lib/observability/run-failures";

beforeEach(() => jest.clearAllMocks());

describe("createRunFailureReporter", () => {
  it("sends one event per op however many rows failed, with count and a sample", () => {
    const failures = createRunFailureReporter("jobs");
    for (let i = 0; i < 40; i++) {
      failures.add("sweep-row", new Error(`row ${i}`), { rowId: `r${i}` });
    }
    failures.add("other-op", new Error("x"));
    expect(reportSentryError).not.toHaveBeenCalled();

    failures.flush();

    expect(reportSentryError).toHaveBeenCalledTimes(2);
    const sweep = reportSentryError.mock.calls.find(
      ([, o]) => o.op === "sweep-row",
    );
    expect(sweep?.[1].extra.count).toBe(40);
    expect(sweep?.[1].extra.sample).toHaveLength(10);
    expect(sweep?.[1].fingerprint).toEqual(["jobs", "sweep-row"]);
  });

  it("resets after a flush so the next run starts clean", () => {
    const failures = createRunFailureReporter("jobs");
    failures.add("op", new Error("a"));
    failures.flush();
    failures.flush();
    expect(reportSentryError).toHaveBeenCalledTimes(1);
  });
});
