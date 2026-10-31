/**
 * "New message": lists the people you can message, searches them, and opens one
 * through the server so the booking check stays the only gate.
 */
import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

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

import { NewMessageDialog } from "../../components/chat/NewMessageDialog";

const person = (
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

let fetchMock: jest.Mock;
let onOpened: jest.Mock;

/** Answers `search-appointments` with `people`, and `/open` with `openResponse`. */
function serve(
  people: unknown[],
  openResponse: { ok: boolean; body: unknown } = {
    ok: true,
    body: { channelType: "messaging", channelId: "dm-me-karen" },
  },
) {
  fetchMock = jest.fn(async (url: string) =>
    url.includes("/api/stream/channels/open")
      ? { ok: openResponse.ok, json: async () => openResponse.body }
      : { ok: true, json: async () => people },
  );
  global.fetch = fetchMock as unknown as typeof fetch;
}

const searchCalls = () =>
  fetchMock.mock.calls
    .map((c) => String((c as unknown as [string])[0]))
    .filter((u) => u.includes("search-appointments"))
    .map((u) => new URL(u, "http://localhost").searchParams);

async function openDialog(
  scope: React.ComponentProps<typeof NewMessageDialog>["scope"] = {
    kind: "personal",
  },
) {
  render(<NewMessageDialog scope={scope} onOpened={onOpened} />);
  await act(async () => {
    fireEvent.click(screen.getByLabelText("New message"));
    await Promise.resolve();
  });
}

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  onOpened = jest.fn();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("listing people", () => {
  it("asks for people only, with no text, in the viewer's zone", async () => {
    serve([person("Karen Anderson", "dm-karen")]);
    await openDialog();

    expect(searchCalls()).toHaveLength(1);
    const params = searchCalls()[0];
    expect(params.get("mode")).toBe("people");
    expect(params.get("q")).toBe("");
    expect(params.get("scope")).toBe("personal");
    expect(params.get("tz")).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    expect(await screen.findByText("Karen Anderson")).toBeTruthy();
  });

  it("scopes the list to the organisation when the page is pinned to one", async () => {
    serve([]);
    await openDialog({ kind: "org", orgId: "org-1" } as never);
    expect(searchCalls()[0].get("scope")).toBe("org:org-1");
  });

  it("shows loading placeholders until the first answer lands", async () => {
    let release: (rows: unknown[]) => void = () => {};
    global.fetch = jest.fn(
      () =>
        new Promise((resolve) => {
          release = (rows) =>
            resolve({ ok: true, json: async () => rows } as Response);
        }),
    ) as unknown as typeof fetch;
    await openDialog();

    expect(
      document.body.querySelector('[class*="animate-pulse"]'),
    ).toBeTruthy();
    expect(screen.queryByText(/No one/)).toBeNull();

    await act(async () => {
      release([person("Karen Anderson", "dm-karen")]);
      await Promise.resolve();
    });
    expect(await screen.findByText("Karen Anderson")).toBeTruthy();
  });

  it("says why it is empty when you have no connections yet", async () => {
    serve([]);
    await openDialog();
    expect(await screen.findByText(/No one to message yet/)).toBeTruthy();
  });

  it("says so when the list could not be loaded, rather than claiming it is empty", async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
    })) as unknown as typeof fetch;
    jest.spyOn(console, "error").mockImplementation(() => {});
    await openDialog();
    expect(await screen.findByText(/could not be loaded/)).toBeTruthy();
    expect(screen.queryByText(/No one to message yet/)).toBeNull();
  });
});

describe("searching", () => {
  it("searches the server after a pause, not on every keystroke", async () => {
    serve([person("Karen Anderson", "dm-karen")]);
    await openDialog();

    fireEvent.change(screen.getByLabelText("Search people"), {
      target: { value: "ka" },
    });
    fireEvent.change(screen.getByLabelText("Search people"), {
      target: { value: "kar" },
    });
    expect(searchCalls()).toHaveLength(1);

    await act(async () => {
      jest.advanceTimersByTime(350);
      await Promise.resolve();
    });
    expect(searchCalls()).toHaveLength(2);
    expect(searchCalls()[1].get("q")).toBe("kar");
  });

  it("does not claim 'no one matches' before the search has run", async () => {
    serve([person("Karen Anderson", "dm-karen")]);
    await openDialog();
    await screen.findByText("Karen Anderson");

    serve([]);
    fireEvent.change(screen.getByLabelText("Search people"), {
      target: { value: "zzz" },
    });
    // Typed but not yet searched: loading, not an empty verdict.
    expect(screen.queryByText(/No one matches/)).toBeNull();

    await act(async () => {
      jest.advanceTimersByTime(350);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await screen.findByText(/No one matches/)).toBeTruthy();
  });

  it("starts from a clean search each time it is opened", async () => {
    serve([person("Karen Anderson", "dm-karen")]);
    await openDialog();
    fireEvent.change(screen.getByLabelText("Search people"), {
      target: { value: "kar" },
    });

    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText("Search people"), {
        key: "Escape",
      });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("New message"));
      await Promise.resolve();
    });

    expect(
      (screen.getByLabelText("Search people") as HTMLInputElement).value,
    ).toBe("");
  });
});

describe("opening a conversation", () => {
  it("opens through the server, lists it, and closes", async () => {
    serve([person("Karen Anderson", "dm-karen")]);
    await openDialog();
    await act(async () => {
      fireEvent.click(await screen.findByText("Karen Anderson"));
      await Promise.resolve();
      await Promise.resolve();
    });

    const openCall = fetchMock.mock.calls.find((c) =>
      String((c as unknown as [string])[0]).includes("/channels/open"),
    ) as unknown as [string, { body: string }];
    expect(JSON.parse(openCall[1].body)).toEqual({
      kind: "dm",
      counterpartyUserId: "dm-karen-user",
      organizationId: null,
    });
    expect(channelFor).toHaveBeenCalledWith("messaging", "dm-me-karen");
    expect(watch).toHaveBeenCalled();
    expect(setActiveChannel).toHaveBeenCalled();
    expect(openPane).toHaveBeenCalled();
    expect(onOpened).toHaveBeenCalledWith(
      expect.objectContaining({ cid: "messaging:dm-me-karen" }),
    );
    expect(screen.queryByLabelText("Search people")).toBeNull();
  });

  it("carries the funding context of an organisation thread", async () => {
    serve([person("Karen Anderson", "dmo-karen", { organizationId: "org-1" })]);
    await openDialog();
    await act(async () => {
      fireEvent.click(await screen.findByText("Karen Anderson"));
      await Promise.resolve();
    });
    const openCall = fetchMock.mock.calls.find((c) =>
      String((c as unknown as [string])[0]).includes("/channels/open"),
    ) as unknown as [string, { body: string }];
    expect(JSON.parse(openCall[1].body).organizationId).toBe("org-1");
  });

  it("keeps the dialog open and says why when the server refuses", async () => {
    serve([person("Karen Anderson", "dm-karen")], {
      ok: false,
      body: {
        error:
          "Direct messages are only available between people who share a booking.",
      },
    });
    await openDialog();
    await act(async () => {
      fireEvent.click(await screen.findByText("Karen Anderson"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      screen.getByText(/only available between people who share a booking/),
    ).toBeTruthy();
    expect(screen.getByLabelText("Search people")).toBeTruthy();
    expect(onOpened).not.toHaveBeenCalled();
    expect(setActiveChannel).not.toHaveBeenCalled();
  });

  it("does not call the server for a row with no person behind it", async () => {
    serve([
      person("Karen Anderson", "dm-karen", { counterpartyUserId: undefined }),
    ]);
    await openDialog();
    await act(async () => {
      fireEvent.click(await screen.findByText("Karen Anderson"));
      await Promise.resolve();
    });
    expect(
      fetchMock.mock.calls.some((c) =>
        String((c as unknown as [string])[0]).includes("/channels/open"),
      ),
    ).toBe(false);
    expect(screen.getByText(/missing its participant/)).toBeTruthy();
  });
});
