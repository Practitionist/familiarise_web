/**
 * A Messages link the viewer can no longer open says so in the conversation
 * pane, instead of "No conversation selected".
 */
import * as React from "react";
import { render, screen } from "@testing-library/react";

jest.mock("../../providers/MaintenanceProvider", () => ({
  useMaintenanceState: () => ({ phase: "NORMAL" }),
}));

jest.mock("stream-chat-react", () => {
  const react = jest.requireActual<typeof import("react")>("react");
  const passthrough = ({ children }: { children?: React.ReactNode }) =>
    react.createElement("div", null, children);

  return {
    Channel: passthrough,
    Window: passthrough,
    MessageList: () =>
      react.createElement("div", { "data-testid": "message-list" }),
    VirtualizedMessageList: () =>
      react.createElement("div", { "data-testid": "message-list" }),
    MessageComposer: () =>
      react.createElement("div", { "data-testid": "message-composer" }),
    WithComponents: passthrough,
    useChatContext: () => ({ channel: undefined }),
    useChannelStateContext: () => ({ messages: [], channel: undefined }),
  };
});

jest.mock("../../components/chat/AppointmentDocumentsHint", () => {
  const react = jest.requireActual<typeof import("react")>("react");
  return {
    AppointmentDocumentsHint: () =>
      react.createElement("div", {
        "data-testid": "appointment-documents-hint",
      }),
  };
});

jest.mock("../../components/chat/BookingTag", () => {
  const react = jest.requireActual<typeof import("react")>("react");
  return {
    BookingTagComposer: () =>
      react.createElement("div", { "data-testid": "message-composer" }),
  };
});

jest.mock("../../components/chat/ComposerDraftPersistence", () => {
  const react = jest.requireActual<typeof import("react")>("react");
  return {
    ComposerDraftPersistence: () =>
      react.createElement("div", { "data-testid": "composer-draft" }),
  };
});

jest.mock("../../components/chat/CustomChannelHeader", () => ({
  CustomChannelHeader: () => null,
}));
jest.mock("../../components/chat/CustomMessage", () => ({
  CustomMessage: () => null,
}));
jest.mock("../../components/chat/SupportInterventionBanner", () => ({
  SupportInterventionBanner: () => null,
}));
jest.mock("../../components/chat/SystemMessage", () => ({
  SystemMessage: () => null,
}));
jest.mock("../../components/stream/StreamErrorBoundary", () => {
  const react = jest.requireActual<typeof import("react")>("react");
  return {
    StreamChatErrorBoundary: ({ children }: { children?: React.ReactNode }) =>
      react.createElement("div", null, children),
  };
});
jest.mock("../../lib/stream-channel-ids", () => ({
  isEventChannel: () => false,
  parseEventChannelId: (id: string) =>
    id.startsWith("class-")
      ? { eventType: "class", eventId: id.slice("class-".length) }
      : null,
}));

import { ChatContainer } from "@/components/chat/ChatContainer";
import { ChatPaneProvider } from "@/components/chat/ChatPaneContext";

const pane = (unavailableLink: "event" | "conversation" | null) => ({
  conversationOpen: true,
  openConversation: () => {},
  unavailableLink,
});

it("names an event chat the viewer can no longer open", () => {
  render(
    <ChatPaneProvider value={pane("event")}>
      <ChatContainer />
    </ChatPaneProvider>,
  );
  expect(
    screen.getByText("This event chat is no longer available to you"),
  ).toBeInTheDocument();
});

it("keeps the picker prompt when no link failed", () => {
  render(
    <ChatPaneProvider value={pane(null)}>
      <ChatContainer />
    </ChatPaneProvider>,
  );
  expect(screen.getByText("No conversation selected")).toBeInTheDocument();
});
