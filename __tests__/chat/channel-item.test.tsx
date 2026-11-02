/**
 * A list row: what it says, and the per-user actions in its menu.
 */
import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Channel } from "stream-chat";

const clientHandlers = new Map<string, () => void>();
jest.mock("stream-chat-react", () => ({
  useChatContext: () => ({
    client: {
      userID: "me",
      on: (type: string, handler: () => void) => {
        clientHandlers.set(type, handler);
        return { unsubscribe: () => clientHandlers.delete(type) };
      },
    },
  }),
}));

import { ChannelItem } from "../../components/chat/ChannelItem";

// Radix positions the menu with these; jsdom has neither.
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const message = (text: string, at: Date) => ({
  text,
  created_at: at.toISOString(),
  user: { id: "them" },
});

/** The part of a channel a row listens to: `on` returns an unsubscribe handle. */
function emitter() {
  const handlers = new Map<string, Set<() => void>>();
  return {
    on: (type: string, handler: () => void) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
      return { unsubscribe: () => handlers.get(type)?.delete(handler) };
    },
    emit: (type: string) => handlers.get(type)?.forEach((h) => h()),
    listenerCount: () =>
      Array.from(handlers.values()).reduce((n, set) => n + set.size, 0),
  };
}

type LiveChannel = Channel & {
  emit: (type: string) => void;
  listenerCount: () => number;
  setUnread: (n: number) => void;
};

function dm(opts: {
  messages?: ReturnType<typeof message>[];
  unread?: number;
}): LiveChannel {
  let unread = opts.unread ?? 0;
  return {
    ...emitter(),
    setUnread: (n: number) => {
      unread = n;
    },
    cid: "messaging:dm-me-them",
    id: "dm-me-them",
    type: "messaging",
    data: {},
    state: {
      messages: opts.messages ?? [],
      members: {
        me: { user: { id: "me", name: "Me" } },
        them: { user: { id: "them", name: "Karen Anderson" } },
      },
    },
    countUnread: () => unread,
  } as unknown as LiveChannel;
}

function team() {
  return {
    cid: "team:class-1",
    id: "class-1",
    type: "team",
    data: { name: "Advanced Class" },
    state: { messages: [], members: {} },
    countUnread: () => 0,
    ...emitter(),
  } as unknown as Channel;
}

function setup(channel: Channel, props: { isPinned?: boolean } = {}) {
  const onClick = jest.fn();
  const onTogglePin = jest.fn();
  const onRemove = jest.fn();
  const view = render(
    <ChannelItem
      channel={channel}
      isActive={false}
      isPinned={props.isPinned ?? false}
      onClick={onClick}
      onTogglePin={onTogglePin}
      onRemove={onRemove}
    />,
  );
  return {
    onClick,
    onTogglePin,
    onRemove,
    unmount: view.unmount,
    container: view.container,
  };
}

const openMenu = (name: string) =>
  fireEvent.keyDown(screen.getByLabelText(`Options for ${name}`), {
    key: "Enter",
  });

describe("what the row says", () => {
  it("shows the other person, the last message and its time today", () => {
    setup(dm({ messages: [message("see you soon", new Date())] }));
    expect(screen.getByText("Karen Anderson")).toBeTruthy();
    expect(screen.getByText("see you soon")).toBeTruthy();
    expect(screen.getByText(/^\d{1,2}:\d{2} [AP]M$/)).toBeTruthy();
  });

  it("says Yesterday for yesterday, not a count of days", () => {
    const yesterdayNoon = new Date();
    yesterdayNoon.setDate(yesterdayNoon.getDate() - 1);
    yesterdayNoon.setHours(12, 0, 0, 0);
    setup(dm({ messages: [message("hello", yesterdayNoon)] }));
    expect(screen.getByText("Yesterday")).toBeTruthy();
  });

  it("invites the first message on an empty conversation", () => {
    setup(dm({}));
    expect(screen.getByText("No messages yet")).toBeTruthy();
  });

  it("shows the unread count, capped", () => {
    setup(dm({ messages: [message("x", new Date())], unread: 14 }));
    expect(screen.getByText("9+")).toBeTruthy();
  });

  it("marks a pinned row for screen readers too", () => {
    setup(dm({}), { isPinned: true });
    expect(screen.getByText("Pinned")).toBeTruthy();
  });

  it("names an event channel by its title", () => {
    setup(team());
    expect(screen.getByText("Advanced Class")).toBeTruthy();
  });
});

describe("opening the row", () => {
  it("clicking the row opens the conversation, not the menu", () => {
    const { onClick, onTogglePin, onRemove } = setup(dm({}));
    fireEvent.click(screen.getByText("Karen Anderson").closest("button")!);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onTogglePin).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("keeps the options button outside the row button", () => {
    setup(dm({}));
    const options = screen.getByLabelText("Options for Karen Anderson");
    expect(options.closest("button[title]")).toBeNull();
  });
});

describe("the options menu", () => {
  it("offers Pin to top on an unpinned row and pins it", () => {
    const { onTogglePin } = setup(dm({}));
    openMenu("Karen Anderson");
    fireEvent.click(screen.getByText("Pin to top"));
    expect(onTogglePin).toHaveBeenCalledWith(expect.anything(), true);
  });

  it("offers Unpin on a pinned row and unpins it", () => {
    const { onTogglePin } = setup(dm({}), { isPinned: true });
    openMenu("Karen Anderson");
    expect(screen.queryByText("Pin to top")).toBeNull();
    fireEvent.click(screen.getByText("Unpin"));
    expect(onTogglePin).toHaveBeenCalledWith(expect.anything(), false);
  });

  it("removes the conversation from the list", () => {
    const { onRemove } = setup(team());
    openMenu("Advanced Class");
    fireEvent.click(screen.getByText("Remove from list"));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

describe("staying current without the list redrawing it", () => {
  it("shows a new message, its time and the unread count when one arrives", () => {
    const channel = dm({});
    setup(channel);
    expect(screen.getByText("No messages yet")).toBeTruthy();

    // The SDK has put the message in state before it emits the event.
    (channel.state.messages as unknown[]).push(message("just in", new Date()));
    channel.setUnread(2);
    act(() => channel.emit("message.new"));

    expect(screen.getByText("just in")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText(/^\d{1,2}:\d{2} [AP]M$/)).toBeTruthy();
    expect(screen.queryByText("No messages yet")).toBeNull();
  });

  it("clears the unread count when the channel is read", () => {
    const channel = dm({ messages: [message("hi", new Date())], unread: 3 });
    setup(channel);
    expect(screen.getByText("3")).toBeTruthy();

    channel.setUnread(0);
    act(() => channel.emit("message.read"));

    expect(screen.queryByText("3")).toBeNull();
  });

  it("clears the count when everything is marked read", () => {
    const channel = dm({ messages: [message("hi", new Date())], unread: 3 });
    setup(channel);

    channel.setUnread(0);
    act(() => clientHandlers.get("notification.mark_read")?.());

    expect(screen.queryByText("3")).toBeNull();
  });

  it("follows an edited or deleted last message", () => {
    const channel = dm({ messages: [message("before", new Date())] });
    setup(channel);

    (channel.state.messages as unknown[]).length = 0;
    (channel.state.messages as unknown[]).push(message("after", new Date()));
    act(() => channel.emit("message.updated"));

    expect(screen.getByText("after")).toBeTruthy();
    expect(screen.queryByText("before")).toBeNull();
  });

  it("stops listening when the row goes away", () => {
    const channel = dm({});
    const { unmount } = setup(channel);
    expect(channel.listenerCount()).toBeGreaterThan(0);
    expect(clientHandlers.size).toBe(1);

    unmount();

    expect(channel.listenerCount()).toBe(0);
    expect(clientHandlers.size).toBe(0);
  });
});

describe("opening the menu while typing in the composer", () => {
  // A modal menu marks the rest of the page aria-hidden. The composer keeps
  // focus when the menu opens, and Chrome blocks hiding an element that holds
  // focus ("Blocked aria-hidden on an element because its descendant retained
  // focus"). The menu is non-modal, so nothing is hidden.
  it("does not hide the rest of the page from assistive technology", () => {
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    composer.focus();
    const { container } = setup(dm({}));

    openMenu("Karen Anderson");

    expect(screen.getByText("Pin to top")).toBeTruthy();
    expect(container.getAttribute("aria-hidden")).toBeNull();
    expect(composer.getAttribute("aria-hidden")).toBeNull();
    composer.remove();
  });
});
