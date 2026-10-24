/**
 * The personal nav badge starts from Stream's own unread total, so it covers
 * channels outside the loaded sidebar page, and still excludes org-tagged ones.
 */
import { act, renderHook } from "@testing-library/react";

type Handler = (event: Record<string, unknown>) => void;
type FakeChannel = {
  cid: string;
  initialized: boolean;
  data: Record<string, unknown>;
  countUnread: () => number;
};

const channel = (
  cid: string,
  unread: number,
  data: Record<string, unknown> = {},
): FakeChannel => ({ cid, initialized: true, data, countUnread: () => unread });

const handlers = new Set<Handler>();
const mockClient = {
  userID: "u1",
  user: { total_unread_count: 0 } as { total_unread_count: number },
  activeChannels: {} as Record<string, FakeChannel>,
  getUnreadCount: jest.fn(),
  queryChannels: jest.fn(),
  on: (handler: Handler) => {
    handlers.add(handler);
    return { unsubscribe: () => handlers.delete(handler) };
  },
};

jest.mock("stream-chat", () => ({
  StreamChat: { getInstance: () => mockClient },
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

type HookModule = typeof import("@/hooks/useChatUnreadCount");
let useChatUnreadCount: HookModule["useChatUnreadCount"];

beforeAll(async () => {
  process.env.NEXT_PUBLIC_STREAM_API_KEY = "test-key";
  useChatUnreadCount = (await import("@/hooks/useChatUnreadCount"))
    .useChatUnreadCount;
});

beforeEach(() => {
  jest.useFakeTimers();
  handlers.clear();
  mockClient.activeChannels = {};
  mockClient.user = { total_unread_count: 0 };
  mockClient.getUnreadCount.mockReset();
  mockClient.queryChannels.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

async function flush() {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(300);
  });
}

describe("useChatUnreadCount", () => {
  it("counts unread outside the loaded page and drops the org-tagged channel", async () => {
    mockClient.user = { total_unread_count: 7 };
    mockClient.getUnreadCount.mockResolvedValue({
      total_unread_count: 7,
      channels: [
        { channel_id: "messaging:a", unread_count: 4, last_read: "" },
        { channel_id: "messaging:org", unread_count: 3, last_read: "" },
      ],
    });
    mockClient.queryChannels.mockResolvedValue([
      channel("messaging:a", 4),
      channel("messaging:org", 3, { organization_id: "o1" }),
    ]);

    const { result } = renderHook(() => useChatUnreadCount());
    await flush();

    expect(result.current).toBe(4);
  });

  it("takes a fresher total from an event without calling the server", async () => {
    let unread = 4;
    mockClient.activeChannels = {
      "messaging:a": {
        ...channel("messaging:a", 0),
        countUnread: () => unread,
      },
    };
    mockClient.user = { total_unread_count: 4 };

    const { result } = renderHook(() => useChatUnreadCount());
    await flush();
    expect(result.current).toBe(4);

    unread = 9;
    act(() => {
      handlers.forEach((h) =>
        h({ type: "notification.message_new", total_unread_count: 9 }),
      );
    });
    await flush();

    expect(result.current).toBe(9);
    expect(mockClient.getUnreadCount).not.toHaveBeenCalled();
  });

  it("keeps a fresher event total over a reconcile snapshot taken before it", async () => {
    mockClient.user = { total_unread_count: 7 };
    mockClient.getUnreadCount.mockResolvedValue({
      total_unread_count: 7,
      channels: [
        { channel_id: "messaging:a", unread_count: 4, last_read: "" },
        { channel_id: "messaging:org", unread_count: 3, last_read: "" },
      ],
    });
    let classify: (found: FakeChannel[]) => void = () => undefined;
    mockClient.queryChannels.mockReturnValue(
      new Promise<FakeChannel[]>((resolve) => {
        classify = resolve;
      }),
    );

    const { result } = renderHook(() => useChatUnreadCount());
    await flush();

    act(() => {
      handlers.forEach((h) =>
        h({ type: "notification.message_new", total_unread_count: 10 }),
      );
    });
    await flush();
    expect(result.current).toBe(10);

    await act(async () => {
      classify([
        channel("messaging:a", 4),
        channel("messaging:org", 3, { organization_id: "o1" }),
      ]);
      await jest.advanceTimersByTimeAsync(0);
    });

    expect(result.current).toBe(7);
  });

  it("excludes a loaded org channel locally", async () => {
    mockClient.activeChannels = {
      "messaging:a": channel("messaging:a", 2),
      "messaging:org": channel("messaging:org", 5, { organization_id: "o1" }),
    };
    mockClient.user = { total_unread_count: 7 };

    const { result } = renderHook(() => useChatUnreadCount());
    await flush();

    expect(result.current).toBe(2);
    expect(mockClient.getUnreadCount).not.toHaveBeenCalled();
  });
});
