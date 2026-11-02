/**
 * The search box now drives two things: the sidebar list, which narrows instantly
 * from what is already loaded, and a dropdown of server results the list cannot
 * hold. These pin how the two hand off without contradicting each other.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("stream-chat-react", () => ({
  useChatContext: () => ({
    client: { userID: "me", channel: jest.fn() },
    setActiveChannel: jest.fn(),
  }),
}));
jest.mock("../../components/chat/ChatPaneContext", () => ({
  useChatPane: () => ({ openConversation: jest.fn() }),
}));
jest.mock("next/image", () => ({ __esModule: true, default: () => null }));

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ChannelSearch } from "../../components/chat/ChannelSearch";

let host: HTMLDivElement;
let root: Root;

const consultation = (
  name: string,
  channelId: string,
  extra: Record<string, unknown> = {},
) => ({
  id: `${channelId}-id`,
  type: "consultation" as const,
  name: `${name}'s plan`,
  counterpartyName: name,
  counterpartyUserId: `${channelId}-user`,
  organizationId: null,
  channelId,
  ...extra,
});

function respondWith(rows: unknown[]) {
  const fetchMock = jest.fn(async () => ({
    ok: true,
    json: async () => rows,
  }));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function type(value: string) {
  const input = host.querySelector("input") as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function settle() {
  await act(async () => {
    jest.advanceTimersByTime(350);
    await Promise.resolve();
    await Promise.resolve();
  });
}

const input = () => host.querySelector("input") as HTMLInputElement;

beforeEach(() => {
  jest.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("handing the term to the sidebar", () => {
  it("reports every keystroke at once, without waiting for the debounce", async () => {
    respondWith([]);
    const onTermChange = jest.fn();
    await act(async () =>
      root.render(<ChannelSearch onTermChange={onTermChange} />),
    );

    await type("kar");

    expect(onTermChange).toHaveBeenLastCalledWith("kar");
  });

  it("clears the term from the clear button", async () => {
    respondWith([]);
    const onTermChange = jest.fn();
    await act(async () =>
      root.render(<ChannelSearch onTermChange={onTermChange} />),
    );
    await type("kar");

    await act(async () => {
      (
        host.querySelector('[aria-label="Clear search"]') as HTMLButtonElement
      ).click();
    });

    expect(input().value).toBe("");
    expect(onTermChange).toHaveBeenLastCalledWith("");
  });
});

describe("handing off to the list", () => {
  it("leaves out rows the list already shows", async () => {
    respondWith([
      consultation("Karen Anderson", "dm-karen"),
      consultation("Karl Marx", "dm-karl"),
    ]);
    await act(async () =>
      root.render(<ChannelSearch listedChannelIds={new Set(["dm-karen"])} />),
    );

    await type("kar");
    await settle();

    expect(host.textContent).not.toContain("Karen Anderson");
    expect(host.textContent).toContain("Karl Marx");
  });

  it("does not say 'No results' while the list below holds matches", async () => {
    respondWith([consultation("Karen Anderson", "dm-karen")]);
    await act(async () =>
      root.render(<ChannelSearch listedChannelIds={new Set(["dm-karen"])} />),
    );

    await type("kar");
    await settle();

    expect(host.textContent).not.toContain("No results found");
  });

  it("still says 'No results' when neither the list nor the server has a match", async () => {
    respondWith([]);
    await act(async () =>
      root.render(<ChannelSearch listedChannelIds={new Set()} />),
    );

    await type("aar");
    await settle();

    expect(host.textContent).toContain("No results found");
  });
});

describe("closing", () => {
  it("an outside click closes the dropdown but keeps the term", async () => {
    respondWith([consultation("Karl Marx", "dm-karl")]);
    const onTermChange = jest.fn();
    await act(async () =>
      root.render(<ChannelSearch onTermChange={onTermChange} />),
    );
    await type("kar");
    await settle();
    expect(host.textContent).toContain("Karl Marx");
    onTermChange.mockClear();

    await act(async () => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });

    expect(host.textContent).not.toContain("Karl Marx");
    expect(input().value).toBe("kar");
    expect(onTermChange).not.toHaveBeenCalled();
  });

  it("typing again reopens it", async () => {
    respondWith([consultation("Karl Marx", "dm-karl")]);
    await act(async () => root.render(<ChannelSearch />));
    await type("kar");
    await settle();
    await act(async () => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });

    await type("karl");
    await settle();

    expect(host.textContent).toContain("Karl Marx");
  });

  it("Escape empties the search", async () => {
    respondWith([consultation("Karl Marx", "dm-karl")]);
    const onTermChange = jest.fn();
    await act(async () =>
      root.render(<ChannelSearch onTermChange={onTermChange} />),
    );
    await type("kar");
    await settle();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(input().value).toBe("");
    expect(onTermChange).toHaveBeenLastCalledWith("");
  });
});

describe("what a row says about why it matched", () => {
  it("sends the viewer's time zone with the query", async () => {
    const fetchMock = respondWith([]);
    await act(async () => root.render(<ChannelSearch />));

    await type("3 nov");
    await settle();

    const url = new URL(
      (fetchMock.mock.calls[0] as unknown as [string])[0],
      "http://localhost",
    );
    expect(url.searchParams.get("q")).toBe("3 nov");
    expect(url.searchParams.get("tz")).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });

  it("shows the session time and a matched email", async () => {
    respondWith([
      consultation("Asha Rao", "dm-asha", {
        startsAt: "2026-11-03T09:00:00.000Z",
        counterpartyEmail: "asha.rao@mail.io",
      }),
    ]);
    await act(async () => root.render(<ChannelSearch />));

    await type("mail.io");
    await settle();

    expect(host.textContent).toContain("asha.rao@mail.io");
    expect(host.textContent).toMatch(/Nov/);
  });

  it("shows the soonest session when one person has several matching bookings", async () => {
    respondWith([
      consultation("Asha Rao", "dm-asha", {
        startsAt: "2026-12-20T09:00:00.000Z",
      }),
      {
        ...consultation("Asha Rao", "dm-asha", {
          startsAt: "2026-11-03T09:00:00.000Z",
        }),
        id: "second",
        name: "Second plan",
      },
    ]);
    await act(async () => root.render(<ChannelSearch />));

    await type("asha");
    await settle();

    expect(host.textContent).toMatch(/Nov/);
    expect(host.textContent).not.toMatch(/Dec/);
  });
});
