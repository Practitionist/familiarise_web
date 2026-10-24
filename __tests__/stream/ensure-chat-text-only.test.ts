/**
 * @jest-environment node
 */

import { getStreamChatClient } from "../../lib/stream-client";
import { ensureChatTextOnly } from "../../scripts/stream/ensure-chat-text-only";

jest.mock("node:fs", () => ({
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: () => true,
  getStreamChatClient: jest.fn(),
}));

type ChannelTypeState = {
  uploads: boolean;
  grants: Record<string, string[]>;
};

const mockGetChannelType = jest.fn();
const mockUpdateChannelType = jest.fn();
const mockGetStreamChatClient = getStreamChatClient as jest.Mock;
const state: Record<string, ChannelTypeState> = {};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  mockGetStreamChatClient.mockReturnValue({
    getChannelType: mockGetChannelType,
    updateChannelType: mockUpdateChannelType,
  });
  state.messaging = {
    uploads: true,
    grants: {
      admin: [
        "create-message",
        "upload-file",
        "upload-attachment",
        "create-attachment",
      ],
      user: ["create-message"],
    },
  };
  state.team = {
    uploads: true,
    grants: {
      admin: ["create-message", "upload-attachment"],
      user: ["create-message"],
    },
  };
  mockGetChannelType.mockImplementation(async (name: string) =>
    structuredClone(state[name]),
  );
  mockUpdateChannelType.mockImplementation(
    async (name: string, patch: Partial<ChannelTypeState>) => {
      state[name] = { ...state[name], ...patch };
    },
  );
});

it("strips every attachment grant and disables uploads on both channel types", async () => {
  await expect(ensureChatTextOnly({ apply: true })).resolves.toBe(0);

  expect(mockUpdateChannelType).toHaveBeenCalledTimes(2);
  for (const name of ["messaging", "team"]) {
    expect(state[name].uploads).toBe(false);
    expect(state[name].grants.admin).toEqual(["create-message"]);
    expect(state[name].grants.user).toEqual(["create-message"]);
  }
});
