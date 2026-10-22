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
    [{ success: false, failed: 1 }, "failure", 500],
    [{ overallSuccess: false }, "failure", 500],
    [{ report: { ok: false } }, "partial_failure", 207],
    [{ held: true }, "held", 503],
    [{ stillFailing: 1 }, "partial_failure", 207],
    [{ orgErrors: 1 }, "partial_failure", 207],
    [{ success: true, remaining: 300 }, "success", 200],
    [{ success: true, errors: ["gateway timeout"] }, "partial_failure", 207],
    [{ success: false, failed: "irrelevant legacy field" }, "failure", 500],
  ])("classifies %j consistently", (result, expected, status) => {
    expect(jobOutcome(result)).toBe(expected);
    expect(statusFor(result)).toBe(status);
  });
});
