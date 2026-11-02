/**
 * A message in a channel outside the loaded page is fetched and listed first,
 * once; load-more pages never repeat a channel the list already holds.
 */
import * as React from "react";
import { act, render, waitFor } from "@testing-library/react";
import type { Channel } from "stream-chat";

type Handler = (event: Record<string, unknown>) => void;

function team(id: string, name: string) {
  return {
    cid: `team:${id}`,
    type: "team",
    id,
    data: { name },
    state: { messages: [], members: {} },
    initialized: true,
    countUnread: () => 0,
    on: () => ({ unsubscribe: () => undefined }),
    watch: jest.fn(() => Promise.resolve()),
  };
}

const registry = new Map<string, ReturnType<typeof team>>();
const handlers = new Set<Handler>();
const mockClient = {
  userID: "me",
  queryChannels: jest.fn(),
  channel: jest.fn((type: string, id: string) => {
    const existing = registry.get(`${type}:${id}`);
    if (existing) return existing;
    const created = team(id, `Channel ${id}`);
    registry.set(created.cid, created);
    return created;
  }),
  // The real client takes `on(handler)` or `on(type, handler)`; only the first is tracked.
  on: (...args: unknown[]) => {
    if (typeof args[0] === "function") handlers.add(args[0] as Handler);
    return { unsubscribe: () => undefined };
  },
  off: (handler: Handler) => handlers.delete(handler),
};

jest.mock("stream-chat-react", () => ({
  useChatContext: () => ({
    client: mockClient,
    setActiveChannel: jest.fn(),
  }),
}));
jest.mock("../../components/chat/ChatPaneContext", () => ({
  useChatPane: () => ({ openConversation: jest.fn() }),
}));
let mockScope: { kind: string; orgId?: string } = { kind: "personal" };
jest.mock("../../hooks/useOrgScope", () => ({
  useOrgScope: () => ({ scope: mockScope }),
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: { user: { role: "CONSULTEE" } } }),
}));
jest.mock("../../components/dashboard/ServerUserId", () => ({
  useServerSessionFacts: () => ({ role: "CONSULTEE" }),
}));
jest.mock("next/navigation", () => ({ useSearchParams: () => null }));
jest.mock("../../components/ui/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("../../components/chat/ChannelSearch", () => ({
  ChannelSearch: () => null,
}));
jest.mock("../../components/chat/CreateChannelDialog", () => ({
  CreateChannelDialog: () => null,
}));
jest.mock("../../components/chat/NewMessageDialog", () => ({
  NewMessageDialog: () => null,
}));
jest.mock("../../components/chat/InitializeUserChannelsButton", () => ({
  InitializeUserChannelsButton: () => null,
}));
jest.mock("../../components/chat/DebugDialog", () => ({
  DebugDialog: () => null,
}));

import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { appendUniqueChannels } from "@/components/chat/utils/channelList";

beforeEach(() => {
  mockScope = { kind: "personal" };
  registry.clear();
  handlers.clear();
  mockClient.queryChannels.mockReset();
  mockClient.queryChannels.mockImplementation(
    async (filter: { type: string }) =>
      filter.type === "team" ? [team("t1", "Loaded channel")] : [],
  );
});

const emit = (event: Record<string, unknown>) =>
  act(async () => {
    handlers.forEach((h) => h(event));
    await Promise.resolve();
  });

const unlistedEvent = {
  type: "notification.message_new",
  channel: { type: "team", id: "t9", cid: "team:t9" },
  message: { created_at: "2026-10-24T10:00:00Z" },
};

const rowTitles = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("button[title]")).map((row) =>
    row.getAttribute("title"),
  );

describe("ChatSidebar", () => {
  it("lists a channel outside the loaded page when a message arrives for it", async () => {
    const { container } = render(<ChatSidebar />);
    await waitFor(() =>
      expect(rowTitles(container)).toEqual(["Loaded channel"]),
    );

    await emit(unlistedEvent);
    await emit(unlistedEvent);

    await waitFor(() =>
      expect(rowTitles(container)).toEqual(["Channel t9", "Loaded channel"]),
    );
    expect(registry.get("team:t9")?.watch).toHaveBeenCalledTimes(1);
  });

  it("does not list a channel whose watch fails, and retries it on the next event", async () => {
    const { container } = render(<ChatSidebar />);
    await waitFor(() =>
      expect(rowTitles(container)).toEqual(["Loaded channel"]),
    );
    const t9 = mockClient.channel("team", "t9");
    t9.watch.mockImplementationOnce(() => Promise.reject(new Error("boom")));

    await emit(unlistedEvent);
    await act(async () => {
      await Promise.resolve();
    });
    expect(rowTitles(container)).toEqual(["Loaded channel"]);

    await emit(unlistedEvent);
    await waitFor(() =>
      expect(rowTitles(container)).toEqual(["Channel t9", "Loaded channel"]),
    );
    expect(t9.watch).toHaveBeenCalledTimes(2);
  });

  it("drops a pending channel when the org scope changes before watch() resolves", async () => {
    const { container, rerender } = render(<ChatSidebar />);
    await waitFor(() =>
      expect(rowTitles(container)).toEqual(["Loaded channel"]),
    );
    let finishWatch: () => void = () => undefined;
    const t9 = mockClient.channel("team", "t9");
    t9.watch.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWatch = resolve;
        }),
    );

    await emit(unlistedEvent);
    mockScope = { kind: "org", orgId: "org_2" };
    rerender(<ChatSidebar />);
    await act(async () => {
      finishWatch();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(rowTitles(container)).not.toContain("Channel t9"),
    );
    expect(t9.watch).toHaveBeenCalledTimes(1);
  });
});

describe("appendUniqueChannels", () => {
  it("drops cids the list already holds, including repeats inside the page", () => {
    const a = team("a", "A") as unknown as Channel;
    const b = team("b", "B") as unknown as Channel;
    const bAgain = team("b", "B") as unknown as Channel;

    expect(appendUniqueChannels([a], [a, b, bAgain])).toEqual([a, b]);
    expect(appendUniqueChannels([a], [a])).toEqual([a]);
  });
});
