/**
 * The inbox: people first, pinned chats on top, and per-user pin and remove that
 * take effect at once and undo themselves when the server refuses.
 */
import * as React from "react";
import {
  act,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";

type Handler = (event: Record<string, unknown>) => void;

type FixtureMessage = {
  text?: string;
  created_at?: string;
  user?: { id: string };
};

function dm(id: string, name: string, pinnedAt: string | null = null) {
  return {
    cid: `messaging:${id}`,
    type: "messaging",
    id,
    data: {},
    state: {
      messages: [] as FixtureMessage[],
      members: {
        me: { user: { id: "me", name: "Me" } },
        [id]: { user: { id, name } },
      },
      membership: pinnedAt ? { pinned_at: pinnedAt } : {},
    },
    initialized: true,
    countUnread: () => 0,
    watch: jest.fn(() => Promise.resolve()),
    on: () => ({ unsubscribe: () => undefined }),
  };
}

function team(id: string, name: string) {
  return {
    cid: `team:${id}`,
    type: "team",
    id,
    data: { name },
    state: { messages: [] as FixtureMessage[], members: {}, membership: {} },
    initialized: true,
    countUnread: () => 0,
    watch: jest.fn(() => Promise.resolve()),
    on: () => ({ unsubscribe: () => undefined }),
  };
}

const handlers = new Set<Handler>();
const mockToast = jest.fn();
const mockClient = {
  userID: "me",
  queryChannels: jest.fn(),
  channel: jest.fn(),
  // The real client takes `on(handler)` or `on(type, handler)`; only the first is tracked.
  on: (...args: unknown[]) => {
    if (typeof args[0] === "function") handlers.add(args[0] as Handler);
    return { unsubscribe: () => undefined };
  },
  off: (handler: Handler) => handlers.delete(handler),
};

jest.mock("stream-chat-react", () => ({
  useChatContext: () => ({ client: mockClient, setActiveChannel: jest.fn() }),
}));
jest.mock("../../components/chat/ChatPaneContext", () => ({
  useChatPane: () => ({ openConversation: jest.fn() }),
}));
jest.mock("../../hooks/useOrgScope", () => ({
  useOrgScope: () => ({ scope: { kind: "personal" } }),
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: { user: { role: "CONSULTEE" } } }),
}));
jest.mock("../../components/dashboard/ServerUserId", () => ({
  useServerSessionFacts: () => ({ role: "CONSULTEE" }),
}));
jest.mock("next/navigation", () => ({ useSearchParams: () => null }));
jest.mock("../../components/ui/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));
jest.mock("../../components/chat/ChannelSearch", () => ({
  ChannelSearch: () => null,
}));
jest.mock("../../components/chat/CreateChannelDialog", () => ({
  CreateChannelDialog: () => null,
}));
jest.mock("../../components/chat/InitializeUserChannelsButton", () => ({
  InitializeUserChannelsButton: () => null,
}));
jest.mock("../../components/chat/DebugDialog", () => ({
  DebugDialog: () => null,
}));
// The picker hands back whatever it opened; this stands in for it.
let mockOpened: unknown = null;
jest.mock("../../components/chat/NewMessageDialog", () => ({
  NewMessageDialog: ({ onOpened }: { onOpened: (c: unknown) => void }) => (
    <button type="button" onClick={() => onOpened(mockOpened)}>
      open-new
    </button>
  ),
}));

import { ChatSidebar } from "@/components/chat/ChatSidebar";

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const karen = dm("karen", "Karen Anderson");
const liam = dm("liam", "Liam Anderson");
const asha = dm("asha", "Asha Rao", "2026-10-20T00:00:00Z");
const beginner = team("class-1", "Beginner Class");
const workshop = team("webinar-1", "Expert Workshop");

let fetchMock: jest.Mock;

beforeEach(() => {
  handlers.clear();
  mockToast.mockClear();
  mockClient.queryChannels.mockReset();
  mockClient.queryChannels.mockImplementation(
    async (filter: { type: string }) =>
      filter.type === "team" ? [beginner, workshop] : [karen, liam, asha],
  );
  // As the real client does, hand back the instance it already holds.
  const held = new Map(
    [karen, liam, asha, beginner, workshop].map((c) => [c.cid, c]),
  );
  mockClient.channel.mockReset();
  mockClient.channel.mockImplementation((type: string, id: string) =>
    held.get(`${type}:${id}`),
  );
  fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({}) }));
  global.fetch = fetchMock as unknown as typeof fetch;
});

/** Row titles in on-screen order. */
const rows = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("button[title]")).map((b) =>
    b.getAttribute("title"),
  );

const headings = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("h2")).map((h) => h.textContent);

async function loaded(container: HTMLElement) {
  await waitFor(() => expect(rows(container).length).toBeGreaterThan(0));
}

const optionsFor = (container: HTMLElement, name: string) =>
  within(container).getByLabelText(`Options for ${name}`);

const openMenu = (container: HTMLElement, name: string) =>
  fireEvent.keyDown(optionsFor(container, name), { key: "Enter" });

describe("order", () => {
  it("puts Conversations above Channels", async () => {
    const { container } = render(<ChatSidebar />);
    await loaded(container);
    expect(headings(container)).toEqual(["Conversations", "Channels"]);
  });

  it("lists people before events", async () => {
    const { container } = render(<ChatSidebar />);
    await loaded(container);
    expect(rows(container)).toEqual([
      "Asha Rao",
      "Karen Anderson",
      "Liam Anderson",
      "Beginner Class",
      "Expert Workshop",
    ]);
  });

  it("asks for pinned chats first, then the latest activity", async () => {
    const { container } = render(<ChatSidebar />);
    await loaded(container);
    const sort = mockClient.queryChannels.mock.calls[0][1];
    expect(sort).toEqual([{ pinned_at: -1 }, { last_message_at: -1 }]);
  });

  it("keeps a pinned chat first even when the server sent it later", async () => {
    const { container } = render(<ChatSidebar />);
    await loaded(container);
    // asha is last in the response and pinned, so she leads the people.
    expect(rows(container).slice(0, 3)).toEqual([
      "Asha Rao",
      "Karen Anderson",
      "Liam Anderson",
    ]);
  });
});

describe("pinning", () => {
  it("pins at once, tells the server, and moves the chat to the top", async () => {
    const { container } = render(<ChatSidebar />);
    await loaded(container);

    openMenu(container, "Liam Anderson");
    await act(async () => {
      fireEvent.click(within(document.body).getByText("Pin to top"));
    });

    expect(rows(container).slice(0, 3)).toEqual([
      "Liam Anderson",
      "Asha Rao",
      "Karen Anderson",
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/stream/channels/preference",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1]
        .body,
    );
    expect(body).toEqual({
      channelType: "messaging",
      channelId: "liam",
      action: "pin",
    });
  });

  it("unpins a pinned chat back into the order", async () => {
    const { container } = render(<ChatSidebar />);
    await loaded(container);

    openMenu(container, "Asha Rao");
    await act(async () => {
      fireEvent.click(within(document.body).getByText("Unpin"));
    });

    expect(rows(container).slice(0, 3)).toEqual([
      "Karen Anderson",
      "Liam Anderson",
      "Asha Rao",
    ]);
  });

  it("undoes the pin and says so when the server refuses", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    const { container } = render(<ChatSidebar />);
    await loaded(container);

    openMenu(container, "Liam Anderson");
    await act(async () => {
      fireEvent.click(within(document.body).getByText("Pin to top"));
    });

    await waitFor(() =>
      expect(rows(container).slice(0, 3)).toEqual([
        "Asha Rao",
        "Karen Anderson",
        "Liam Anderson",
      ]),
    );
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
  });
});

describe("removing from the list", () => {
  it("drops the chat at once and asks the server to hide it, keeping history", async () => {
    const { container } = render(<ChatSidebar />);
    await loaded(container);
    // Stream leaves a hidden channel out of every later query.
    mockClient.queryChannels.mockImplementation(
      async (filter: { type: string }) =>
        filter.type === "team" ? [beginner, workshop] : [liam, asha],
    );

    openMenu(container, "Karen Anderson");
    await act(async () => {
      fireEvent.click(within(document.body).getByText("Remove from list"));
    });

    expect(rows(container)).not.toContain("Karen Anderson");
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1]
        .body,
    );
    expect(body).toEqual({
      channelType: "messaging",
      channelId: "karen",
      action: "hide",
    });
  });

  it("brings it back and says so when the server refuses", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    const { container } = render(<ChatSidebar />);
    await loaded(container);
    const loadsBefore = mockClient.queryChannels.mock.calls.length;

    openMenu(container, "Karen Anderson");
    await act(async () => {
      fireEvent.click(within(document.body).getByText("Remove from list"));
    });

    await waitFor(() => expect(rows(container)).toContain("Karen Anderson"));
    expect(mockClient.queryChannels.mock.calls.length).toBeGreaterThan(
      loadsBefore,
    );
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
  });

  it("does not flash the loading skeleton while restoring", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    const { container } = render(<ChatSidebar />);
    await loaded(container);

    openMenu(container, "Karen Anderson");
    await act(async () => {
      fireEvent.click(within(document.body).getByText("Remove from list"));
    });

    // Rows stay on screen through the refetch instead of being replaced.
    expect(container.querySelector('[class*="animate-pulse"]')).toBeNull();
  });
});

describe("a conversation opened from search or the picker", () => {
  it("is listed first among the unpinned people, so it is there when you look back", async () => {
    mockOpened = dm("nina", "Nina Kapoor");
    const { container, getByText } = render(<ChatSidebar />);
    await loaded(container);

    await act(async () => {
      fireEvent.click(getByText("open-new"));
    });

    // Asha is pinned, so she stays on top; the new chat leads the rest.
    expect(rows(container).slice(0, 2)).toEqual(["Asha Rao", "Nina Kapoor"]);
    // Listed once, however many times it is opened.
    await act(async () => {
      fireEvent.click(getByText("open-new"));
    });
    expect(rows(container).filter((t) => t === "Nina Kapoor")).toHaveLength(1);
  });
});

describe("a hidden thread shown again", () => {
  it("is listed when Stream reports it visible", async () => {
    const back = dm("karen2", "Karen Two");
    mockClient.channel.mockReturnValue(back);
    const { container } = render(<ChatSidebar />);
    await loaded(container);

    await act(async () => {
      handlers.forEach((h) =>
        h({
          type: "channel.visible",
          user: { id: "me" },
          channel: { type: "messaging", id: "karen2", cid: "messaging:karen2" },
        }),
      );
      await Promise.resolve();
    });

    await waitFor(() => expect(rows(container)).toContain("Karen Two"));
  });
});

describe("live updates", () => {
  // Stream sends `message.new` for a channel the client is watching with the
  // ids only (`cid`, `channel_type`, `channel_id`); only `notification.*`
  // events carry a `channel` object. An open thread is always watched.
  const incoming = (id: string, text: string) => {
    const at = new Date().toISOString();
    return {
      text,
      at,
      event: {
        type: "message.new",
        cid: `messaging:${id}`,
        channel_type: "messaging",
        channel_id: id,
        message: { created_at: at },
      },
    };
  };

  it("moves a conversation up and shows its new message when the event carries only channel ids", async () => {
    const { container } = render(<ChatSidebar />);
    await loaded(container);
    const { text, at, event } = incoming("liam", "see you at five");
    // By the time a listener runs, the SDK has already put the message in state.
    liam.state.messages.push({ text, created_at: at, user: { id: "liam" } });

    await act(async () => {
      handlers.forEach((h) => h(event));
      await Promise.resolve();
    });

    // Asha stays first because she is pinned; Liam now leads the rest.
    expect(rows(container).slice(0, 3)).toEqual([
      "Asha Rao",
      "Liam Anderson",
      "Karen Anderson",
    ]);
    expect(container.textContent).toContain("see you at five");
  });
});
