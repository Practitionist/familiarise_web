/**
 * The booking chip tags only the next message sent; a rendered tag comes only
 * from the server's verified answer, never from message fields; the retired
 * booking cards stay hidden; and event channels say who can read them.
 */
import * as React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  localMessageToNewMessagePayload,
  type LocalMessage,
} from "stream-chat";

type SubmitParams = {
  cid: string;
  localMessage: Record<string, unknown>;
  message: Record<string, unknown>;
  sendOptions: Record<string, unknown>;
};

type SentParams = {
  localMessage: Record<string, unknown>;
  message: Record<string, unknown>;
};
const mockSendMessage = jest
  .fn<Promise<void>, [SentParams]>()
  .mockResolvedValue();
let mockChannel: Record<string, unknown>;
let mockMessage: Record<string, unknown>;

jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
let mockFinePointer = true;
jest.mock("../../hooks/use-media-query", () => ({
  useMediaQuery: () => mockFinePointer,
}));
jest.mock("../../components/chat/ChannelInfoAndManageDialog", () => ({
  ChannelInfoAndManageDialog: () => null,
}));
jest.mock("stream-chat-react", () => ({
  Attachment: () => null,
  MessageComposer: ({
    overrideSubmitHandler,
  }: {
    overrideSubmitHandler: (p: SubmitParams) => Promise<void>;
  }) => (
    <button
      type="button"
      onClick={() =>
        void overrideSubmitHandler({
          cid: "messaging:dm-1",
          localMessage: { id: "local", text: "hi" },
          message: { id: "local", text: "hi" },
          sendOptions: {},
        })
      }
    >
      Send
    </button>
  ),
  useChannelStateContext: () => ({ channel: mockChannel }),
  useChannelActionContext: () => ({ sendMessage: mockSendMessage }),
  useChatContext: () => ({ client: { userID: "me" }, channel: mockChannel }),
  useMessageContext: () => ({ message: mockMessage }),
  useMessageComposerController: () => ({ setQuotedMessage: jest.fn() }),
}));

import { BookingTagComposer } from "@/components/chat/BookingTag";
import { CustomMessage } from "@/components/chat/CustomMessage";
import { CustomChannelHeader } from "@/components/chat/CustomChannelHeader";
import { lastVisibleMessage } from "@/components/chat/utils/channelUtils";

const NEXT = "2099-01-02T10:00:00.000Z";
const verified = {
  title: "Career coaching",
  kind: "CONSULTATION",
  nextSessionAt: NEXT,
  lastSessionAt: null,
};
const fetchMock = jest.fn();

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

function answer(status: number, body: unknown) {
  fetchMock.mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => body,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFinePointer = true;
  global.fetch = fetchMock;
  mockChannel = { cid: "messaging:dm-1", type: "messaging", id: "dm-1" };
});

describe("BookingTagComposer", () => {
  it("tags only the first message sent and posts nothing on open", async () => {
    answer(200, verified);
    renderWithQuery(<BookingTagComposer contextAppointmentId="apt-1" />);

    const chip = await screen.findByTestId("booking-tag-chip");
    expect(chip).toHaveTextContent(
      `About: Career coaching · next session ${format(new Date(NEXT), "EEE, d MMM, h:mm a")}`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/stream/booking-tag?appointmentId=apt-1&cid=messaging%3Adm-1",
    );
    expect(mockSendMessage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));
    expect(mockSendMessage.mock.calls[0][0]).toMatchObject({
      localMessage: { booking_appointment_id: "apt-1" },
      message: { booking_appointment_id: "apt-1" },
    });
    expect(screen.queryByTestId("booking-tag-chip")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(2));
    expect(mockSendMessage.mock.calls[1][0].message).not.toHaveProperty(
      "booking_appointment_id",
    );
  });

  it("keeps the tag on a failed send, so the SDK retry resends it", async () => {
    answer(200, verified);
    renderWithQuery(<BookingTagComposer contextAppointmentId="apt-1" />);
    await screen.findByTestId("booking-tag-chip");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));

    // The failed copy the SDK stores, and the payload its retry sends from it.
    const failed = {
      ...mockSendMessage.mock.calls[0][0].localMessage,
      created_at: new Date(),
      status: "failed",
    } as unknown as LocalMessage;
    expect(localMessageToNewMessagePayload(failed)).toMatchObject({
      id: "local",
      booking_appointment_id: "apt-1",
    });
  });

  it("reserves the chip row while the lookup runs and collapses it on a 404", async () => {
    let settle: (value: unknown) => void = () => {};
    fetchMock.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    renderWithQuery(<BookingTagComposer contextAppointmentId="apt-1" />);
    expect(screen.getByTestId("booking-tag-reserve")).toBeInTheDocument();

    settle({ ok: false, status: 404, json: async () => ({}) });
    await waitFor(() =>
      expect(
        screen.queryByTestId("booking-tag-reserve"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId("booking-tag-chip")).not.toBeInTheDocument();
  });

  it("sends untagged once the chip is removed, or when the server refuses it", async () => {
    answer(200, verified);
    const view = renderWithQuery(
      <BookingTagComposer contextAppointmentId="apt-1" />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove booking tag" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));
    expect(mockSendMessage.mock.calls[0][0].message).not.toHaveProperty(
      "booking_appointment_id",
    );
    view.unmount();

    answer(404, { error: "Not found" });
    renderWithQuery(<BookingTagComposer contextAppointmentId="apt-2" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("booking-tag-chip")).not.toBeInTheDocument();
  });
});

describe("CustomMessage booking tag", () => {
  const forged = {
    id: "m1",
    type: "regular",
    text: "Hello",
    created_at: new Date("2026-10-22T10:00:00Z"),
    user: { id: "them", name: "Them" },
    booking_appointment_id: "apt-1",
    booking_title: "Forged title",
    booking_starts_at: "2030-01-01T00:00:00.000Z",
  };

  it("ignores client-supplied title and date", async () => {
    mockMessage = forged;
    answer(404, { error: "Not found" });
    const view = renderWithQuery(<CustomMessage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId("booking-tag")).not.toBeInTheDocument();
    expect(screen.queryByText(/Forged title/)).not.toBeInTheDocument();
    view.unmount();

    answer(200, verified);
    renderWithQuery(<CustomMessage />);
    const tag = await screen.findByTestId("booking-tag");
    expect(tag).toHaveTextContent(/^Career coaching$/);
    const label = `About: Career coaching · next session ${format(new Date(NEXT), "EEE, d MMM, h:mm a")}`;
    expect(tag).toHaveAccessibleName(label);
    act(() => tag.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent(label);
    expect(screen.queryByText(/Forged title/)).not.toBeInTheDocument();
    expect(screen.queryByText("Get help")).not.toBeInTheDocument();
  });

  it("on touch, shows a bubble's actions only after a tap on it", () => {
    mockFinePointer = false;
    mockMessage = { ...forged, booking_appointment_id: undefined };
    renderWithQuery(<CustomMessage />);
    expect(
      screen.queryByRole("button", { name: "Reply to message" }),
    ).toBeNull();

    fireEvent.click(screen.getByTestId("message-bubble"));
    expect(
      screen.getByRole("button", { name: "Reply to message" }),
    ).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(
      screen.queryByRole("button", { name: "Reply to message" }),
    ).toBeNull();
  });

  it("hides the retired server-posted booking cards", () => {
    mockMessage = {
      ...forged,
      text: "Booking context: Career coaching",
      user: { id: "system-booking-context", name: "Familiarise" },
    };
    const { container } = renderWithQuery(<CustomMessage />);
    expect(container).toBeEmptyDOMElement();
  });
});

it("labels an event channel with its host, headcount and audience", () => {
  mockChannel = {
    cid: "team:class-1",
    type: "team",
    id: "class-1",
    data: {
      name: "Algebra 101",
      created_by: { name: "Asha" },
      member_count: 5,
    },
    state: { members: {} },
  };
  render(<CustomChannelHeader />);
  expect(screen.getByText("Algebra 101")).toBeInTheDocument();
  // Outside the Messages layout there is no list to go back to.
  expect(
    screen.queryByRole("button", { name: "Back to conversations" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText(
      "group chat · Asha (host) + 4 classmates · Everyone in this class can read this",
    ),
  ).toBeInTheDocument();
});

it("previews the latest message that is not a retired booking card", () => {
  const card = { id: "c", user: { id: "system-booking-context" } };
  const hello = { id: "h", user: { id: "them" } };
  expect(lastVisibleMessage([hello, card])).toBe(hello);
  expect(lastVisibleMessage([card])).toBeNull();
});
