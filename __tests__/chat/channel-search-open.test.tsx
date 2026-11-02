/**
 * Opening a search result goes through the server, tells the sidebar which
 * channel it opened, and clears the box only when it worked.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const setActiveChannel = jest.fn();
const openPane = jest.fn();
const watch = jest.fn(async () => undefined);
const channelFor = jest.fn((type: string, id: string) => ({
  cid: `${type}:${id}`,
  type,
  id,
  watch,
}));

jest.mock("stream-chat-react", () => ({
  useChatContext: () => ({
    client: { userID: "me", channel: channelFor },
    setActiveChannel,
  }),
}));
jest.mock("../../components/chat/ChatPaneContext", () => ({
  useChatPane: () => ({ openConversation: openPane }),
}));
jest.mock("next/image", () => ({ __esModule: true, default: () => null }));

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ChannelSearch } from "../../components/chat/ChannelSearch";

let host: HTMLDivElement;
let root: Root;

const row = {
  id: "c1",
  type: "consultation" as const,
  name: "Career plan",
  counterpartyName: "Karen Anderson",
  counterpartyUserId: "karen-user",
  organizationId: null,
  channelId: "dm-karen",
};

function serve(openResponse: { ok: boolean; body: unknown }) {
  const fetchMock = jest.fn(async (url: string) =>
    url.includes("/channels/open")
      ? { ok: openResponse.ok, json: async () => openResponse.body }
      : { ok: true, json: async () => [row] },
  );
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

async function search(term: string) {
  await type(term);
  await act(async () => {
    jest.advanceTimersByTime(350);
    await Promise.resolve();
    await Promise.resolve();
  });
}

const clickResult = () =>
  act(async () => {
    const button = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Karen Anderson"),
    ) as HTMLButtonElement;
    button.click();
    await Promise.resolve();
    await Promise.resolve();
  });

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  jest.useRealTimers();
});

it("opens through the server, reports the channel, and empties the box", async () => {
  const fetchMock = serve({
    ok: true,
    body: { channelType: "messaging", channelId: "dm-me-karen" },
  });
  const onOpened = jest.fn();
  await act(async () => root.render(<ChannelSearch onOpened={onOpened} />));
  await search("karen");
  await clickResult();

  const openCall = fetchMock.mock.calls.find((c) =>
    String((c as unknown as [string])[0]).includes("/channels/open"),
  ) as unknown as [string, { body: string }];
  expect(JSON.parse(openCall[1].body)).toEqual({
    kind: "dm",
    counterpartyUserId: "karen-user",
    organizationId: null,
  });
  expect(channelFor).toHaveBeenCalledWith("messaging", "dm-me-karen");
  expect(setActiveChannel).toHaveBeenCalled();
  expect(openPane).toHaveBeenCalled();
  expect(onOpened).toHaveBeenCalledWith(
    expect.objectContaining({ cid: "messaging:dm-me-karen" }),
  );
  expect((host.querySelector("input") as HTMLInputElement).value).toBe("");
});

it("keeps the search and says why when the server refuses", async () => {
  serve({
    ok: false,
    body: { error: "No booking ties this conversation to that organization." },
  });
  const onOpened = jest.fn();
  await act(async () => root.render(<ChannelSearch onOpened={onOpened} />));
  await search("karen");
  await clickResult();

  expect(host.textContent).toContain("No booking ties this conversation");
  expect((host.querySelector("input") as HTMLInputElement).value).toBe("karen");
  expect(onOpened).not.toHaveBeenCalled();
  expect(setActiveChannel).not.toHaveBeenCalled();
});

it("works without anyone listening for the opened channel", async () => {
  serve({
    ok: true,
    body: { channelType: "messaging", channelId: "dm-me-karen" },
  });
  await act(async () => root.render(<ChannelSearch />));
  await search("karen");
  await clickResult();
  expect(setActiveChannel).toHaveBeenCalled();
});
