/** @jest-environment node */
import { jobOutcome } from "../../lib/cron/job-outcome";
import { statusFor } from "../../lib/cron/cleanup-route";

jest.mock("../../lib/cron/with-cron-lock", () => ({}));
jest.mock("../../lib/maintenance-cron", () => ({}));
jest.mock("@sentry/nextjs", () => ({}));

describe("job outcomes", () => {
  it.each([
    [{ failed: 1, remaining: 10 }, "partial_failure", 207],
    [{ skipped: 3, failed: 1 }, "partial_failure", 207],
    [{ errors: ["outbox row threw"] }, "partial_failure", 207],
    [{ failed: 0, exhaustedReported: 1 }, "partial_failure", 207],
    [{ ok: false, summary: { status: "COMPLETED" } }, "partial_failure", 207],
    [{ ok: false, summary: { status: "RUNNING" } }, "success", 200],
    [{ success: false, failed: 1 }, "failure", 500],
    [{ overallSuccess: false }, "failure", 500],
    [{ success: false, failed: "irrelevant legacy field" }, "failure", 500],
    [{ held: true }, "held", 503],
    [{ success: true, remaining: 300 }, "success", 200],
    // An explicit verdict outranks counters that only describe the run's work.
    [{ success: true, scanned: 4, failed: 4, errored: 0 }, "success", 200],
    [{ success: true, stillFailing: 2, errors: ["retrying"] }, "success", 200],
    [{ success: true, failed: 1, orgErrors: 1 }, "success", 200],
    [{ success: true, report: { ok: false } }, "success", 200],
    [{ overallSuccess: true, errorCount: 3 }, "success", 200],
    [{ stillFailing: 1, orgErrors: 1, errorCount: 1 }, "success", 200],
  ])("classifies %j consistently", (result, expected, status) => {
    expect(jobOutcome(result)).toBe(expected);
    expect(statusFor(result)).toBe(status);
  });
});
