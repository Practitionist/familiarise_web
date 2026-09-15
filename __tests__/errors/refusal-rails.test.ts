/**
 * @jest-environment node
 */

/**
 * The refusal rail: a `Refusal` handed to `apiError` answers its own status
 * with the user's sentence and never reaches Sentry, a plain `Error` still
 * answers 500 and is captured, and the client reads the user's sentence back
 * off either wire shape.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import * as Sentry from "@sentry/nextjs";
import { apiError } from "../../lib/errors/api-error";
import { Refusal } from "../../lib/errors/refusal";
import { refusalResult } from "../../lib/errors/action-result";
import {
  isExpectedRefusal,
  userMessageFrom,
} from "../../lib/errors/client-refusal";
import { ApiResponseError } from "../../lib/fetch-helpers";

const captureException = Sentry.captureException as jest.Mock;

describe("apiError with a Refusal", () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  const error = jest
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  afterAll(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  it("answers the refusal's status and user message without capturing", async () => {
    const res = apiError({
      tag: "[Test]",
      error: new Refusal({
        code: "NOT_OWNER",
        httpStatus: 403,
        userMessage: "Only this consultant can see their appointment details.",
        devMessage: "Forbidden: consultant c-1 is not owned by user u-1",
      }),
    });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "Only this consultant can see their appointment details.",
      errorType: "NOT_OWNER",
      code: "NOT_OWNER",
    });
    expect(captureException).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Forbidden: consultant c-1"),
    );
  });

  it("still answers 500 and captures a plain Error", async () => {
    const res = apiError({ tag: "[Test]", error: new Error("boom") });
    expect(res.status).toBe(500);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0][1]).not.toMatchObject({
      level: "info",
    });
  });
});

describe("userMessageFrom", () => {
  it("reads the sentence off an ApiResponseError, a Refusal and an ActionResult", () => {
    expect(
      userMessageFrom(
        new ApiResponseError("Cannot switch schedule type now.", {
          status: 400,
          code: "SCHEDULE_LOCKED",
        }),
      ),
    ).toBe("Cannot switch schedule type now.");
    const refusal = new Refusal({
      code: "TIME_NOT_PICKED",
      httpStatus: 422,
      userMessage: "Pick a time first.",
      devMessage: "no startsAt in search params",
    });
    expect(userMessageFrom(refusal)).toBe("Pick a time first.");
    expect(userMessageFrom(refusalResult(refusal))).toBe("Pick a time first.");
    expect(userMessageFrom(new Error("ECONNRESET"), "Try again.")).toBe(
      "Try again.",
    );
  });

  it("marks only refusals as expected", () => {
    expect(isExpectedRefusal(new Refusal({ code: "X", userMessage: "x" }))).toBe(
      true,
    );
    expect(
      isExpectedRefusal(new ApiResponseError("nope", { status: 409 })),
    ).toBe(true);
    expect(
      isExpectedRefusal(new ApiResponseError("down", { status: 503 })),
    ).toBe(false);
    expect(isExpectedRefusal(new Error("boom"))).toBe(false);
  });
});
