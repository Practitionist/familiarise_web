/**
 * @jest-environment node
 *
 * Pin, unpin and hide change only the caller's own list, and only for a
 * conversation the caller is a member of. Hiding keeps the history.
 */
import { NextRequest } from "next/server";

let mockAuthError: Response | null = null;
const mockQueryChannels = jest.fn();
const mockPin = jest.fn(async (_opts: { user_id: string }) => ({}));
const mockUnpin = jest.fn(async (_opts: { user_id: string }) => ({}));
const mockHide = jest.fn(
  async (_userId: string, _clearHistory: boolean) => ({}),
);

jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: async () =>
    mockAuthError
      ? { error: mockAuthError }
      : { session: { user: { id: "me", role: "CONSULTEE" } } },
}));
jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: () => ({
    queryChannels: (...a: unknown[]) => mockQueryChannels(...a),
  }),
  withStreamCircuitBreaker: <T>(fn: () => Promise<T>) => fn(),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { POST } from "../../app/api/stream/channels/preference/route";

const found = { pin: mockPin, unpin: mockUnpin, hide: mockHide };

async function call(body: unknown) {
  const res = await POST(
    new NextRequest("http://localhost/api/stream/channels/preference", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

const valid = { channelType: "messaging", channelId: "dm-a-b" };

beforeEach(() => {
  mockAuthError = null;
  mockQueryChannels.mockResolvedValue([found]);
});

describe("access", () => {
  it("passes an auth refusal straight through", async () => {
    const { NextResponse } = await import("next/server");
    mockAuthError = NextResponse.json({ error: "no" }, { status: 401 });
    expect((await call({ ...valid, action: "pin" })).status).toBe(401);
    expect(mockQueryChannels).not.toHaveBeenCalled();
  });

  it.each([
    ["not json", "{"],
    ["unknown action", { ...valid, action: "delete" }],
    [
      "unknown channel type",
      { ...valid, channelType: "livestream", action: "pin" },
    ],
    ["empty channel id", { ...valid, channelId: "", action: "pin" }],
    [
      "oversized channel id",
      { ...valid, channelId: "x".repeat(65), action: "pin" },
    ],
  ])("rejects %s", async (_label, body) => {
    expect((await call(body)).status).toBe(400);
    expect(mockQueryChannels).not.toHaveBeenCalled();
  });

  it("only finds the channel with the caller as a member, and refuses otherwise", async () => {
    mockQueryChannels.mockResolvedValue([]);
    const res = await call({ ...valid, action: "hide" });

    expect(res.status).toBe(404);
    expect(mockQueryChannels.mock.calls[0][0]).toEqual({
      type: "messaging",
      id: { $eq: "dm-a-b" },
      members: { $in: ["me"] },
    });
    expect(mockHide).not.toHaveBeenCalled();
    expect(mockPin).not.toHaveBeenCalled();
  });
});

describe("what each action does", () => {
  it("pins for the caller only", async () => {
    expect((await call({ ...valid, action: "pin" })).status).toBe(200);
    expect(mockPin).toHaveBeenCalledWith({ user_id: "me" });
    expect(mockUnpin).not.toHaveBeenCalled();
  });

  it("unpins for the caller only", async () => {
    expect((await call({ ...valid, action: "unpin" })).status).toBe(200);
    expect(mockUnpin).toHaveBeenCalledWith({ user_id: "me" });
  });

  it("hides for the caller and keeps the history", async () => {
    expect(
      (
        await call({
          ...valid,
          channelType: "team",
          channelId: "class-1",
          action: "hide",
        })
      ).status,
    ).toBe(200);
    expect(mockHide).toHaveBeenCalledWith("me", false);
  });

  it("answers 500 when Stream fails, without claiming success", async () => {
    mockPin.mockRejectedValueOnce(new Error("stream down"));
    const res = await call({ ...valid, action: "pin" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "Could not update this conversation. Please try again.",
    });
  });
});
