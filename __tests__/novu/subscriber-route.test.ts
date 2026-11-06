/**
 * @jest-environment node
 */

const mockGetSession = jest.fn();
const mockFindUnique = jest.fn();
const mockSyncSubscriber = jest.fn();
const mockComputeSubscriberHash = jest.fn();
const mockCaptureException = jest.fn();

jest.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

jest.mock("../../lib/auth-server", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: (...args: unknown[]) => mockFindUnique(...args) },
  },
}));

jest.mock("../../lib/novu/subscriber", () => ({
  computeSubscriberHash: (...args: unknown[]) =>
    mockComputeSubscriberHash(...args),
  syncSubscriber: (...args: unknown[]) => mockSyncSubscriber(...args),
}));

import { POST } from "@/app/api/novu/subscriber/route";

const subscriberHash = "f".repeat(64);

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
  mockFindUnique.mockResolvedValue({
    id: "user-1",
    name: "Asha Rao",
    email: "asha@example.com",
    phone: null,
    image: null,
    timezone: "Asia/Kolkata",
    orgWorkspaceProfile: null,
  });
  mockComputeSubscriberHash.mockReturnValue(subscriberHash);
  mockSyncSubscriber.mockResolvedValue(undefined);
});

afterEach(() => jest.restoreAllMocks());

describe("POST /api/novu/subscriber", () => {
  it("returns the session user's hash after syncing the profile", async () => {
    const res = await POST();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      success: true,
      subscriberHash,
    });
    expect(mockComputeSubscriberHash).toHaveBeenCalledWith("user-1");
    expect(mockSyncSubscriber).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        firstName: "Asha",
        lastName: "Rao",
      }),
    );
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("still returns the hash when the Novu profile sync fails", async () => {
    mockSyncSubscriber.mockRejectedValue(new Error("Novu 503"));

    const res = await POST();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      success: true,
      subscriberHash,
    });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException.mock.calls[0][1]).toMatchObject({
      level: "warning",
    });
  });

  it("returns 503 without a hash when the Inbox secret is not configured", async () => {
    mockComputeSubscriberHash.mockReturnValue(undefined);

    const res = await POST();

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.not.toHaveProperty("subscriberHash");
    expect(mockSyncSubscriber).not.toHaveBeenCalled();
  });

  it("rejects a request without a session", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await POST();

    expect(res.status).toBe(401);
    expect(mockComputeSubscriberHash).not.toHaveBeenCalled();
  });

  it("returns 404 for a session whose user no longer exists", async () => {
    mockFindUnique.mockResolvedValue(null);

    const res = await POST();

    expect(res.status).toBe(404);
    expect(mockComputeSubscriberHash).not.toHaveBeenCalled();
  });
});
