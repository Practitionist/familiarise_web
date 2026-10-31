/**
 * A list row: what it says, and the per-user actions in its menu.
 */
import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Channel } from "stream-chat";

jest.mock("stream-chat-react", () => ({
  useChatContext: () => ({ client: { userID: "me" } }),
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

function dm(opts: {
  messages?: ReturnType<typeof message>[];
  unread?: number;
}) {
  return {
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
    countUnread: () => opts.unread ?? 0,
  } as unknown as Channel;
}

function team() {
  return {
    cid: "team:class-1",
    id: "class-1",
    type: "team",
    data: { name: "Advanced Class" },
    state: { messages: [], members: {} },
    countUnread: () => 0,
  } as unknown as Channel;
}

function setup(channel: Channel, props: { isPinned?: boolean } = {}) {
  const onClick = jest.fn();
  const onTogglePin = jest.fn();
  const onRemove = jest.fn();
  render(
    <ChannelItem
      channel={channel}
      isActive={false}
      isPinned={props.isPinned ?? false}
      onClick={onClick}
      onTogglePin={onTogglePin}
      onRemove={onRemove}
    />,
  );
  return { onClick, onTogglePin, onRemove };
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
