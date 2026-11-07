/**
 * @jest-environment node
 */

const mockGetSession = jest.fn();
const mockComputeSubscriberHash = jest.fn();
const mockCaptureException = jest.fn();

jest.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

jest.mock("../../lib/auth-server", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

jest.mock("../../lib/novu/subscriber", () => ({
  computeSubscriberHash: (...args: unknown[]) =>
    mockComputeSubscriberHash(...args),
}));

import { POST } from "@/app/api/novu/subscriber/route";

const subscriberHash = "f".repeat(64);

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
  mockComputeSubscriberHash.mockReturnValue(subscriberHash);
});

afterEach(() => jest.restoreAllMocks());

describe("POST /api/novu/subscriber", () => {
  it("returns the session user's hash without any provider call", async () => {
    const res = await POST();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      success: true,
      subscriberHash,
    });
    expect(mockComputeSubscriberHash).toHaveBeenCalledWith("user-1");
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("returns 503 without a hash when the Inbox secret is not configured", async () => {
    mockComputeSubscriberHash.mockReturnValue(undefined);

    const res = await POST();

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.not.toHaveProperty("subscriberHash");
  });

  it("rejects a request without a session", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await POST();

    expect(res.status).toBe(401);
    expect(mockComputeSubscriberHash).not.toHaveBeenCalled();
  });

  it("reports an unexpected failure once and returns 500", async () => {
    mockGetSession.mockRejectedValue(new Error("session store down"));

    const res = await POST();

    expect(res.status).toBe(500);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});
