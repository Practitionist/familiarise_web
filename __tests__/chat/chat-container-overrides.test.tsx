/**
 * ChatContainer is text-only: it replaces the composer's attachment selector
 * with a null component, and the appointment documents hint only appears above
 * a live composer (never in read-only maintenance mode).
 */
import * as React from "react";
import { render, screen } from "@testing-library/react";

let mockPhase: string | null = "NORMAL";
let mockOverrides: Record<string, React.ComponentType> | undefined;

const mockChannel = {
  type: "messaging",
  id: "dm-1",
  state: { members: {}, messages: [] },
};

jest.mock("../../providers/MaintenanceProvider", () => ({
  useMaintenanceState: () => ({ phase: mockPhase }),
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
    WithComponents: ({
      children,
      overrides,
    }: {
      children?: React.ReactNode;
      overrides?: Record<string, React.ComponentType>;
    }) => {
      mockOverrides = overrides;
      return react.createElement("div", null, children);
    },
    useChatContext: () => ({ channel: mockChannel }),
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
}));
jest.mock("../../components/dashboard/DataCard", () => ({
  EmptyState: () => null,
}));

import { ChatContainer } from "@/components/chat/ChatContainer";

beforeEach(() => {
  mockPhase = "NORMAL";
  mockOverrides = undefined;
});

describe("ChatContainer", () => {
  it("replaces the attachment selector with a null component", () => {
    render(<ChatContainer />);

    expect(mockOverrides?.MessageSystem).toBeDefined();
    const Selector = mockOverrides?.AttachmentSelector;
    if (!Selector) {
      throw new Error("AttachmentSelector override is missing");
    }
    const { container } = render(<Selector />);
    expect(container).toBeEmptyDOMElement();
  });

  it("mounts the documents hint above the composer", () => {
    render(<ChatContainer />);

    const hint = screen.getByTestId("appointment-documents-hint");
    const composer = screen.getByTestId("message-composer");
    expect(hint).toBeInTheDocument();
    expect(composer).toBeInTheDocument();
    expect(
      hint.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("hides the composer and hint while chat is read-only", () => {
    mockPhase = "DEGRADED";
    render(<ChatContainer />);

    expect(screen.queryByTestId("message-composer")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("appointment-documents-hint"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Chat is temporarily read-only during maintenance."),
    ).toBeInTheDocument();
  });
});
