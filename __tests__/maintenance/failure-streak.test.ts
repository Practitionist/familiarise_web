/**
 * @jest-environment node
 */
import {
  isPlatformErrorBody,
  isRepeatedFailure,
} from "../../lib/cron/failure-streak";

const now = new Date("2026-10-27T12:00:00Z");
const minutesAgo = (m: number) =>
  new Date(now.getTime() - m * 60_000).toISOString();

describe("isRepeatedFailure", () => {
  it("is a repeat once nothing completed for three cadences", () => {
    expect(
      isRepeatedFailure(
        5,
        { lastCompletedAt: minutesAgo(16), seenRecently: true },
        now,
      ),
    ).toBe(true);
  });

  it("is a one-off when the target completed within three cadences", () => {
    expect(
      isRepeatedFailure(
        5,
        { lastCompletedAt: minutesAgo(6), seenRecently: true },
        now,
      ),
    ).toBe(false);
  });

  it("scales with the target's own cadence", () => {
    expect(
      isRepeatedFailure(
        15,
        { lastCompletedAt: minutesAgo(40), seenRecently: true },
        now,
      ),
    ).toBe(false);
    expect(
      isRepeatedFailure(
        15,
        { lastCompletedAt: minutesAgo(50), seenRecently: true },
        now,
      ),
    ).toBe(true);
  });

  it("treats a never-completed target with history as a repeat and unknown history as a one-off", () => {
    expect(
      isRepeatedFailure(5, { lastCompletedAt: null, seenRecently: true }, now),
    ).toBe(true);
    expect(
      isRepeatedFailure(5, { lastCompletedAt: null, seenRecently: false }, now),
    ).toBe(false);
    expect(isRepeatedFailure(5, undefined, now)).toBe(false);
  });
});

describe("isPlatformErrorBody", () => {
  it("recognises Netlify's own error page only", () => {
    expect(isPlatformErrorBody("Internal Server Error - Request ID: 01H")).toBe(
      true,
    );
    expect(isPlatformErrorBody('{"error":"boom"}')).toBe(false);
    expect(isPlatformErrorBody(undefined)).toBe(false);
  });
});
