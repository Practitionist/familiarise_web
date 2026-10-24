/**
 * The profile fetch gating the Stream connect retries with capped backoff and,
 * once its budget is spent, surfaces a typed failure that Retry can clear.
 */
import { act, renderHook } from "@testing-library/react";

const mockFetchUserDetails = jest.fn();
const mockReport = jest.fn();

jest.mock("../../lib/user", () => ({
  fetchUserDetails: (...args: unknown[]) => mockFetchUserDetails(...args),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => mockReport(...args),
}));

import { useUserData } from "@/hooks/useUserData";

const user = { id: "u1", name: "U One" };

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockFetchUserDetails.mockReset();
  mockReport.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("useUserData", () => {
  it("retries a failed fetch and loads the profile when a later attempt works", async () => {
    mockFetchUserDetails
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(user);

    const { result } = renderHook(() => useUserData("u1"));
    await advance(0);
    expect(result.current.isLoading).toBe(true);

    await advance(10_000);
    expect(mockFetchUserDetails).toHaveBeenCalledTimes(3);
    expect(result.current.userDetails).toEqual(user);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.failure).toBeNull();
    expect(mockReport).not.toHaveBeenCalled();
  });

  it("surfaces one typed failure after the budget, and Retry starts a fresh budget", async () => {
    mockFetchUserDetails.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useUserData("u1"));
    await advance(60_000);

    expect(mockFetchUserDetails).toHaveBeenCalledTimes(4);
    expect(result.current.failure).toMatchObject({
      kind: "retryable",
      action: "retry",
    });
    expect(result.current.isLoading).toBe(false);
    expect(mockReport).toHaveBeenCalledTimes(1);

    mockFetchUserDetails.mockReset();
    mockFetchUserDetails.mockResolvedValue(user);
    act(() => result.current.retry());
    await advance(10);

    expect(result.current.userDetails).toEqual(user);
    expect(result.current.failure).toBeNull();
  });

  it("does not retry or report a 401 after sign-out", async () => {
    mockFetchUserDetails.mockRejectedValue(
      Object.assign(new Error("unauthorized"), { status: 401 }),
    );

    const { result } = renderHook(() => useUserData("u1"));
    await advance(60_000);

    expect(mockFetchUserDetails).toHaveBeenCalledTimes(1);
    expect(result.current.failure).toBeNull();
    expect(mockReport).not.toHaveBeenCalled();
  });
});
