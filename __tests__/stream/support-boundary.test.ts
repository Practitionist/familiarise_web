/** @jest-environment node */

const mockChannel = {
  updatePartial: jest.fn(async () => ({})),
  watch: jest.fn(),
};
const mockChat = { channel: jest.fn(() => mockChannel) };

jest.mock("../../lib/stream-client", () => ({
  __esModule: true,
  getStreamChatClient: () => mockChat,
  withStreamCircuitBreaker: (op: () => Promise<unknown>) => op(),
  isExpectedStreamError: (err: unknown) =>
    (err as { status?: number })?.status === 404,
  streamErrorCode: () => null,
}));

const mockLive: { current: { id: string } | null } = { current: null };
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    supportCaseChatAccess: {
      findFirst: jest.fn(async () => mockLive.current),
    },
  },
}));

import prisma from "../../lib/prisma";
import {
  CLEARED_BOUNDARY_GRANTS,
  SUPPORT_BOUNDARY_GRANTS,
  syncSupportBoundary,
} from "../../lib/stream/support-boundary";

const NOW = new Date("2026-10-20T10:00:00Z");
const REVOKED = [
  "!update-channel-members",
  "!update-channel-members-owner",
  "!truncate-channel-owner",
];

beforeEach(() => {
  jest.clearAllMocks();
  mockLive.current = null;
});

it("looks for any live grant, READ or INTERVENE, on the channel", async () => {
  await syncSupportBoundary("messaging", "dm-a-b", NOW);
  expect(prisma.supportCaseChatAccess.findFirst).toHaveBeenCalledWith({
    where: {
      channelType: "messaging",
      channelId: "dm-a-b",
      endedAt: null,
      expiresAt: { gt: NOW },
    },
    select: { id: true },
  });
});

it("revokes member changes and owner truncation for user and channel_moderator while a grant is live", async () => {
  mockLive.current = { id: "g1" };
  await expect(syncSupportBoundary("messaging", "dm-a-b", NOW)).resolves.toBe(
    "locked",
  );
  expect(mockChat.channel).toHaveBeenCalledWith("messaging", "dm-a-b");
  expect(mockChannel.updatePartial).toHaveBeenCalledWith({
    set: {
      config_overrides: {
        grants: { user: REVOKED, channel_moderator: REVOKED },
      },
    },
  });
  expect(SUPPORT_BOUNDARY_GRANTS).toEqual({
    user: REVOKED,
    channel_moderator: REVOKED,
  });
  expect(mockChannel.watch).not.toHaveBeenCalled();
});

it("clears the modifiers with empty per-role lists once no grant is live", async () => {
  await expect(syncSupportBoundary("team", "webinar-web-1", NOW)).resolves.toBe(
    "unlocked",
  );
  expect(mockChannel.updatePartial).toHaveBeenCalledWith({
    set: {
      config_overrides: { grants: { user: [], channel_moderator: [] } },
    },
  });
  expect(CLEARED_BOUNDARY_GRANTS).toEqual({ user: [], channel_moderator: [] });
});

it("answers gone for a channel retention deleted", async () => {
  mockChannel.updatePartial.mockRejectedValueOnce(
    Object.assign(new Error("not found"), { status: 404 }),
  );
  await expect(syncSupportBoundary("messaging", "dm-a-b", NOW)).resolves.toBe(
    "gone",
  );
});

it("rethrows any other Stream failure for the caller to retry", async () => {
  mockChannel.updatePartial.mockRejectedValueOnce(new Error("stream 503"));
  await expect(syncSupportBoundary("messaging", "dm-a-b", NOW)).rejects.toThrow(
    "stream 503",
  );
});
