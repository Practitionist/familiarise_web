/**
 * The chat sheet resolves a target through the open route once per session:
 * a reopen reuses the cached channel, skips the POST, and the booking-tag
 * lookup starts as soon as the channel id is known.
 */
import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type FakeChannel = { cid: string; initialized: boolean; watch: jest.Mock };
let mockActive: FakeChannel | undefined;
const mockWatch = jest.fn(async () => undefined);
const mockChannels = new Map<string, FakeChannel>();

jest.mock("stream-chat-react", () => ({
  useChatContext: () => ({
    client: {
      userID: "me",
      channel: (type: string, id: string) => {
        const cid = `${type}:${id}`;
        const existing = mockChannels.get(cid);
        if (existing) return existing;
        const created: FakeChannel = {
          cid,
          initialized: false,
          watch: jest.fn(async () => {
            created.initialized = true;
            await mockWatch();
          }),
        };
        mockChannels.set(cid, created);
        return created;
      },
    },
    channel: mockActive,
    setActiveChannel: async (channel: FakeChannel) => {
      mockActive = channel;
    },
  }),
}));
jest.mock("../../components/chat/ChatSurface", () => ({
  ChatSurface: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("../../components/chat/ChatContainer", () => ({
  ChatContainer: () => <div data-testid="chat-container" />,
}));
jest.mock("../../hooks/useOrgScope", () => ({
  useOrgScope: () => ({ scope: { kind: "personal" } }),
}));

import { AppointmentChatSheet } from "@/components/appointments/detail/AppointmentChatSheet";

const fetchMock = jest.fn(async (url: string, init?: { method?: string }) =>
  init?.method === "POST"
    ? {
        ok: true,
        status: 200,
        json: async () => ({ channelType: "messaging", channelId: "dm-a-b" }),
      }
    : { ok: false, status: 404, json: async () => ({}) },
);
const posts = () =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").length;
const tagLookups = () =>
  fetchMock.mock.calls.filter(([url]) =>
    url.startsWith("/api/stream/booking-tag"),
  ).length;

const target = {
  kind: "dm" as const,
  title: "Message Liam Anderson",
  messagesHref: "/dashboard/consultee/c/messages",
  counterpartyUserId: "liam",
  appointmentId: "apt-1",
};

function open(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <AppointmentChatSheet target={target} onClose={jest.fn()} />
    </QueryClientProvider>,
  );
}

it("reuses the opened channel on reopen without posting or watching again", async () => {
  global.fetch = fetchMock as unknown as typeof fetch;
  const client = new QueryClient();

  const first = open(client);
  await screen.findByTestId("chat-container");
  expect(posts()).toBe(1);
  expect(tagLookups()).toBe(1);
  expect(mockWatch).toHaveBeenCalledTimes(1);
  first.unmount();

  open(client);
  await waitFor(() =>
    expect(screen.getByTestId("chat-container")).toBeInTheDocument(),
  );
  expect(posts()).toBe(1);
  expect(mockWatch).toHaveBeenCalledTimes(1);
});
