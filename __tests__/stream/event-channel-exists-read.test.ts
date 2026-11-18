/**
 * @jest-environment node
 */

// Asking whether an event chat exists reads Stream by channel id and never
// asks Stream to make the channel. A chat that is not there is an ordinary
// answer; only a failed read is reported.

const mockQueryChannels = jest.fn();
const mockChannel = jest.fn();
const mockCapture = jest.fn();
const mockMarkExists = jest.fn();

jest.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCapture(...args),
}));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/stream-client", () => ({
  ...jest.requireActual("../../lib/stream-client"),
  getStreamChatClient: () => ({
    queryChannels: (...args: unknown[]) => mockQueryChannels(...args),
    channel: (...args: unknown[]) => mockChannel(...args),
  }),
}));
jest.mock("../../lib/stream-cache", () => ({
  isChannelCached: () => undefined,
  markChannelExists: (...args: unknown[]) => mockMarkExists(...args),
  getMembershipCached: jest.fn(),
  markMembership: jest.fn(),
}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));
jest.mock("../../actions/stream/chat/user.action", () => ({}));

import { checkEventChannelExists } from "../../lib/stream/event-channel-service";

beforeEach(() => jest.clearAllMocks());

describe("checking whether an event chat exists", () => {
  it("answers false for a chat that is not there, creating and reporting nothing", async () => {
    mockQueryChannels.mockResolvedValue([]);

    await expect(checkEventChannelExists("webinar", "w-1")).resolves.toBe(
      false,
    );

    expect(mockQueryChannels).toHaveBeenCalledWith(
      { cid: { $eq: "team:webinar-w-1" } },
      [],
      expect.objectContaining({ limit: 1, watch: false, presence: false }),
    );
    // No channel handle is opened, so nothing can ask Stream to create one.
    expect(mockChannel).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockMarkExists).not.toHaveBeenCalled();
  });

  it("answers true for a chat that is there and remembers it", async () => {
    mockQueryChannels.mockResolvedValue([
      { cid: "messaging:consultation-c-1" },
    ]);

    await expect(checkEventChannelExists("consultation", "c-1")).resolves.toBe(
      true,
    );

    expect(mockMarkExists).toHaveBeenCalledWith(
      "messaging",
      "consultation-c-1",
    );
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("reports a failed read once and answers false", async () => {
    mockQueryChannels.mockRejectedValue(new Error("stream is down"));

    await expect(checkEventChannelExists("class", "cl-1")).resolves.toBe(false);

    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockMarkExists).not.toHaveBeenCalled();
  });
});
