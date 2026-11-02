/**
 * A pin, unpin or hide moves rows across the paging offset; the sidebar re-reads
 * its loaded rows so no conversation is skipped and none is listed twice.
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

function dm(id: string, name: string, lastMessageAt: string) {
  return {
    cid: `messaging:${id}`,
    type: "messaging",
    id,
    data: { last_message_at: lastMessageAt },
    state: {
      messages: [],
      members: {
        me: { user: { id: "me", name: "Me" } },
        [id]: { user: { id, name } },
      },
      membership: {} as { pinned_at?: string },
    },
    initialized: true,
    countUnread: () => 0,
    markRead: jest.fn(() => Promise.resolve()),
    watch: jest.fn(() => Promise.resolve()),
    on: () => ({ unsubscribe: () => undefined }),
  };
}
type Row = ReturnType<typeof dm>;

const handlers = new Set<Handler>();
const mockClient = {
  userID: "me",
  queryChannels: jest.fn(),
  channel: jest.fn(),
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
jest.mock("../../components/chat/InitializeUserChannelsButton", () => ({
  InitializeUserChannelsButton: () => null,
}));
jest.mock("../../components/chat/DebugDialog", () => ({
  DebugDialog: () => null,
}));
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

/**
 * Stream's contract for this inbox: per-user pins first (latest pin on top),
 * then latest activity, hidden channels left out, offset/limit slicing.
 */
function serveInbox(recentCount: number, { withOldPin = true } = {}) {
  const all: Row[] = Array.from({ length: recentCount }, (_, i) =>
    dm(
      `recent-${i}`,
      `Recent person ${i}`,
      new Date(Date.UTC(2026, 10, 2, 12, -i)).toISOString(),
    ),
  );
  const pinned = new Map<string, string>();
  const hidden = new Set<string>();
  if (withOldPin) {
    all.push(dm("old-pin", "Old pinned", "2026-09-01T00:00:00Z"));
    pinned.set("old-pin", "2026-10-01T00:00:00Z");
  }
  const pinnedMs = (row: Row) => Date.parse(pinned.get(row.id) ?? "") || 0;
  const order = () =>
    all
      .filter((row) => !hidden.has(row.id))
      .sort(
        (a, b) =>
          pinnedMs(b) - pinnedMs(a) ||
          Date.parse(b.data.last_message_at) -
            Date.parse(a.data.last_message_at),
      );
  // A page held back here resolves only when the test releases it.
  const held: Array<() => void> = [];
  let holdNextPage = false;

  mockClient.queryChannels.mockImplementation(
    async (
      filter: { type: string },
      _sort: unknown,
      options: { limit: number; offset?: number },
    ) => {
      if (filter.type === "team") return [];
      const offset = options.offset ?? 0;
      const page = order().slice(offset, offset + options.limit);
      for (const row of page) {
        const at = pinned.get(row.id);
        row.state.membership = at ? { pinned_at: at } : {};
      }
      if (holdNextPage && offset > 0) {
        holdNextPage = false;
        return new Promise<Row[]>((resolve) => held.push(() => resolve(page)));
      }
      return page;
    },
  );
  mockClient.channel.mockImplementation((type: string, id: string) =>
    all.find((row) => row.cid === `${type}:${id}`),
  );
  let clock = Date.UTC(2026, 10, 3);
  global.fetch = jest.fn(async (_url: string, init: { body: string }) => {
    const { channelId, action } = JSON.parse(init.body);
    // A server clock that always ticks, so pins processed back to back never tie.
    if (action === "pin")
      pinned.set(channelId, new Date(clock++).toISOString());
    if (action === "unpin") pinned.delete(channelId);
    if (action === "hide") hidden.add(channelId);
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;

  return {
    names: () => order().map((row) => row.state.members[row.id].user.name),
    row: (id: string) => all.find((r) => r.id === id)!,
    show: (id: string) => hidden.delete(id),
    holdNextPage: () => {
      holdNextPage = true;
    },
    releaseHeld: () => held.splice(0).forEach((release) => release()),
  };
}

beforeEach(() => {
  handlers.clear();
  mockOpened = null;
  mockScope = { kind: "personal" };
  mockClient.queryChannels.mockReset();
  mockClient.channel.mockReset();
});

const rows = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("button[title]")).map((b) =>
    b.getAttribute("title"),
  );
const loadMoreButton = (container: HTMLElement) =>
  within(container).queryByText(/Load more/);

async function clickLoadMore(container: HTMLElement) {
  await act(async () => {
    fireEvent.click(loadMoreButton(container)!);
  });
}

async function loadEverything(container: HTMLElement) {
  while (loadMoreButton(container)) {
    const before = rows(container).length;
    await clickLoadMore(container);
    await waitFor(() =>
      expect(
        rows(container).length > before || !loadMoreButton(container),
      ).toBe(true),
    );
  }
}

/** Renders the inbox with "Recent person 0" open, so the open row is not the one moved. */
async function mount() {
  const view = render(<ChatSidebar />);
  await waitFor(() => expect(rows(view.container).length).toBeGreaterThan(0));
  fireEvent.click(
    view.container.querySelector('button[title="Recent person 0"]')!,
  );
  return view;
}

async function choose(container: HTMLElement, name: string, item: string) {
  fireEvent.keyDown(within(container).getByLabelText(`Options for ${name}`), {
    key: "Enter",
  });
  await act(async () => {
    fireEvent.click(within(document.body).getByText(item));
  });
}

it("reaches every conversation when nothing changes between pages", async () => {
  const server = serveInbox(20);
  const { container } = render(<ChatSidebar />);
  await waitFor(() => expect(rows(container)).toHaveLength(20));
  await loadEverything(container);
  expect(rows(container)).toEqual(server.names());
});

it.each([
  ["fewer than one page", 14, 0],
  ["exactly one page", 19, 0],
  ["one page and one row", 20, 0],
  ["several pages", 44, 1],
])(
  "unpinning with %s loaded skips and repeats nothing",
  async (_label, recentCount, extraPages) => {
    const server = serveInbox(recentCount);
    const { container } = await mount();
    for (let i = 0; i < extraPages; i++) await clickLoadMore(container);
    const loaded = rows(container).length;

    await choose(container, "Old pinned", "Unpin");
    await waitFor(() =>
      expect(rows(container)).toEqual(server.names().slice(0, loaded)),
    );

    await loadEverything(container);
    expect(rows(container)).toEqual(server.names());
  },
);

it("hiding a loaded row pulls the next unseen one into view", async () => {
  const server = serveInbox(21, { withOldPin: false });
  const { container } = render(<ChatSidebar />);
  await waitFor(() => expect(rows(container)).toHaveLength(20));

  await choose(container, "Recent person 5", "Remove from list");
  await waitFor(() => expect(rows(container)).toEqual(server.names()));
  expect(rows(container)).toContain("Recent person 20");
  expect(loadMoreButton(container)).not.toBeNull();
  await loadEverything(container);
  expect(rows(container)).toEqual(server.names());
});

it("a restored row that a later page repeats is listed once", async () => {
  const server = serveInbox(21, { withOldPin: false });
  const { container, getByText } = render(<ChatSidebar />);
  await waitFor(() => expect(rows(container)).toHaveLength(20));
  await choose(container, "Recent person 5", "Remove from list");
  await waitFor(() => expect(rows(container)).toContain("Recent person 20"));

  server.show("recent-5");
  mockOpened = server.row("recent-5");
  await act(async () => {
    fireEvent.click(getByText("open-new"));
  });
  await loadEverything(container);

  const listed = rows(container);
  expect(listed[0]).toBe("Recent person 5");
  expect(new Set(listed).size).toBe(listed.length);
  expect([...listed].sort()).toEqual([...server.names()].sort());
});

it("drops a page that was in flight when the rebase replaced the list", async () => {
  const server = serveInbox(40);
  const { container } = await mount();

  server.holdNextPage();
  await clickLoadMore(container);
  await choose(container, "Old pinned", "Unpin");
  await waitFor(() =>
    expect(rows(container)).toEqual(server.names().slice(0, 20)),
  );

  await act(async () => server.releaseHeld());
  expect(rows(container)).toEqual(server.names().slice(0, 20));

  await loadEverything(container);
  expect(rows(container)).toEqual(server.names());
});

it("keeps the open conversation listed when an unpin moves it past the loaded rows", async () => {
  const server = serveInbox(20);
  const { container } = render(<ChatSidebar />);
  await waitFor(() => expect(rows(container)).toHaveLength(20));

  // The first row opens on load, so this unpins the open conversation.
  await choose(container, "Old pinned", "Unpin");
  await waitFor(() => expect(rows(container)).toContain("Recent person 19"));
  expect(rows(container)[0]).toBe("Old pinned");

  await loadEverything(container);
  expect([...rows(container)].sort()).toEqual([...server.names()].sort());
});

/** Rejects the next `count` messaging reads, as a transient Stream outage would. */
function failMessagingReads(count: number) {
  const original = mockClient.queryChannels.getMockImplementation()!;
  let left = count;
  mockClient.queryChannels.mockImplementation((filter, sort, options) => {
    if (filter.type !== "messaging" || left === 0) {
      return original(filter, sort, options);
    }
    left -= 1;
    return Promise.reject(new Error("Transient Stream read failure"));
  });
}

/** Holds each messaging read (its page cut when issued) until `stop()`. */
function holdMessagingReads() {
  const original = mockClient.queryChannels.getMockImplementation()!;
  const held: Array<() => void> = [];
  let holding = true;
  mockClient.queryChannels.mockImplementation(async (filter, sort, options) => {
    const page: Row[] = await original(filter, sort, options);
    if (!holding || filter.type !== "messaging") return page;
    // Like Stream, a read writes its membership into the shared channels as it resolves.
    const memberships = page.map((row) => row.state.membership);
    return new Promise((resolve) =>
      held.push(() => {
        page.forEach((row, i) => (row.state.membership = memberships[i]));
        resolve(page);
      }),
    );
  });
  return {
    held,
    stop: () => {
      holding = false;
    },
  };
}

/** A hide the server refuses, which starts the silent undo refresh. */
function failHides() {
  const answer = global.fetch;
  global.fetch = jest.fn((url: string, init: { body: string }) =>
    JSON.parse(init.body).action === "hide"
      ? Promise.resolve({ ok: false, json: async () => ({}) })
      : answer(url, init),
  ) as unknown as typeof fetch;
}

describe("when a re-read fails or lands out of order", () => {
  let errors: jest.SpyInstance;
  beforeEach(() => {
    errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => errors.mockRestore());

  it("retries a failed re-read once and repairs the list", async () => {
    const server = serveInbox(20);
    const { container } = await mount();
    failMessagingReads(1);
    await choose(container, "Old pinned", "Unpin");
    await waitFor(() =>
      expect(rows(container)).toEqual(server.names().slice(0, 20)),
    );
    await loadEverything(container);
    expect(rows(container)).toEqual(server.names());
  });

  it("re-reads on Load more when the retry fails too, so nothing is skipped", async () => {
    const server = serveInbox(20);
    const { container } = await mount();
    failMessagingReads(2);
    await choose(container, "Old pinned", "Unpin");
    await waitFor(() => expect(errors).toHaveBeenCalled());
    expect(rows(container)).not.toContain("Recent person 19");

    await loadEverything(container);
    expect(rows(container)).toEqual(server.names());
  });

  it("drops an older refresh that lands after a newer re-read", async () => {
    const server = serveInbox(20);
    const { container } = await mount();
    const reads = holdMessagingReads();
    failHides();
    await choose(container, "Recent person 5", "Remove from list");
    await waitFor(() => expect(reads.held).toHaveLength(1));
    reads.stop();
    await choose(container, "Old pinned", "Unpin");
    await waitFor(() =>
      expect(rows(container)).toEqual(server.names().slice(0, 20)),
    );

    await act(async () => reads.held[0]());
    expect(rows(container)).toEqual(server.names().slice(0, 20));
    await loadEverything(container);
    expect(rows(container)).toEqual(server.names());
  });

  it("shows the server's pins after an older refresh lands late", async () => {
    const server = serveInbox(5);
    const { container, rerender } = await mount();
    const reads = holdMessagingReads();
    failHides();
    await choose(container, "Recent person 2", "Remove from list");
    await waitFor(() => expect(reads.held).toHaveLength(1));
    reads.stop();
    await choose(container, "Old pinned", "Unpin");
    await waitFor(() => expect(rows(container)).toEqual(server.names()));

    await act(async () => reads.held[0]());
    rerender(<ChatSidebar />);
    const oldPin = () =>
      container.querySelector<HTMLElement>('button[title="Old pinned"]')!;
    await waitFor(() =>
      expect(within(oldPin()).queryByText("Pinned")).toBeNull(),
    );
    expect(rows(container)).toEqual(server.names());
  });

  it("accepts a newer refresh that lands after an older re-read", async () => {
    const server = serveInbox(20);
    const { container } = await mount();
    const reads = holdMessagingReads();
    await choose(container, "Old pinned", "Unpin");
    await waitFor(() => expect(reads.held).toHaveLength(1));
    server.row("recent-19").data.last_message_at = "2026-11-03T00:00:00Z";
    failHides();
    await choose(container, "Recent person 5", "Remove from list");
    await waitFor(() => expect(reads.held).toHaveLength(2));
    reads.stop();

    await act(async () => reads.held[0]());
    await act(async () => reads.held[1]());
    expect(rows(container)).toEqual(server.names().slice(0, 20));
    expect(rows(container)[0]).toBe("Recent person 19");
    await loadEverything(container);
    expect(rows(container)).toEqual(server.names());
  });

  it("shows the server's pin order once overlapping pins settle", async () => {
    const server = serveInbox(20);
    const { container } = await mount();
    const answer = global.fetch;
    const queued: Array<() => void> = [];
    global.fetch = jest.fn(
      (url: string, init: { body: string }) =>
        new Promise((resolve) => queued.push(() => resolve(answer(url, init)))),
    ) as unknown as typeof fetch;
    for (const name of [
      "Recent person 3",
      "Recent person 6",
      "Recent person 9",
    ]) {
      await choose(container, name, "Pin to top");
    }
    // The server handles the requests in reverse, so the last click pins first.
    while (queued.length > 0) await act(async () => queued.pop()!());

    await waitFor(() =>
      expect(rows(container)).toEqual(server.names().slice(0, 20)),
    );
    expect(rows(container).slice(0, 3)).toEqual([
      "Recent person 3",
      "Recent person 6",
      "Recent person 9",
    ]);
  });

  it("drops a re-read cut for the previous scope", async () => {
    serveInbox(20);
    const { container, rerender } = await mount();
    const reads = holdMessagingReads();
    await choose(container, "Old pinned", "Unpin");
    await waitFor(() => expect(reads.held).toHaveLength(1));
    reads.stop();
    const personal = mockClient.queryChannels.getMockImplementation()!;
    const orgRow = dm("org-person", "Org person", "2026-11-01T00:00:00Z");
    mockClient.queryChannels.mockImplementation((filter, sort, options) =>
      mockScope.kind === "org"
        ? Promise.resolve(filter.type === "messaging" ? [orgRow] : [])
        : personal(filter, sort, options),
    );

    mockScope = { kind: "org", orgId: "org_2" };
    rerender(<ChatSidebar />);
    await waitFor(() => expect(rows(container)).toEqual(["Org person"]));
    await act(async () => reads.held[0]());
    expect(rows(container)).toEqual(["Org person"]);
  });
});
