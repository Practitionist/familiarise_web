/**
 * @jest-environment node
 *
 * Opening an event channel brings it back to a list the caller had removed it
 * from, and a failure to do that never blocks the open.
 */
import { NextRequest } from "next/server";

const mockShow = jest.fn(async (_userId: string) => ({}));
const mockChannel = jest.fn();
const mockIsParticipant = jest.fn();
const mockAdmit = jest.fn();

jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: async () => ({ session: { user: { id: "me" } } }),
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: async () => null,
  streamApiLimiter: {},
}));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../actions/stream/chat/channel.action", () => ({
  createCollaboratorChannel: jest.fn(),
  createDirectMessageChannel: jest.fn(),
}));
jest.mock("../../actions/stream/chat/user.action", () => ({
  upsertUsersToStream: jest.fn(),
  upsertUserToStream: jest.fn(),
}));
jest.mock("../../lib/stream/event-channel-service", () => ({
  isEventParticipant: (...a: unknown[]) => mockIsParticipant(...a),
  addUserToEventChannel: (...a: unknown[]) => mockAdmit(...a),
}));
jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: () => ({
    channel: (...a: unknown[]) => {
      mockChannel(...a);
      return { show: mockShow };
    },
  }),
  withStreamCircuitBreaker: <T>(fn: () => Promise<T>) => fn(),
  StreamUnavailableError: class StreamUnavailableError extends Error {},
  isExpectedStreamError: () => false,
}));

async function openEvent() {
  const { POST } = await import("../../app/api/stream/channels/open/route");
  return POST(
    new NextRequest("http://localhost/api/stream/channels/open", {
      method: "POST",
      body: JSON.stringify({
        kind: "event",
        eventType: "class",
        eventId: "e1",
      }),
    }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsParticipant.mockResolvedValue(true);
  mockAdmit.mockResolvedValue({ success: true });
});

it("shows the event channel for the caller once admitted", async () => {
  const res = await openEvent();
  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toEqual({
    channelType: "team",
    channelId: "class-e1",
  });
  expect(mockChannel).toHaveBeenCalledWith("team", "class-e1");
  expect(mockShow).toHaveBeenCalledWith("me");
});

it("still opens when showing the channel fails", async () => {
  mockShow.mockRejectedValueOnce(new Error("stream down"));
  expect((await openEvent()).status).toBe(200);
});

it("touches nothing for someone who is not a participant", async () => {
  mockIsParticipant.mockResolvedValue(false);
  expect((await openEvent()).status).toBe(403);
  expect(mockShow).not.toHaveBeenCalled();
});
