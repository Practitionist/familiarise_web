/**
 * A dropped socket inside its grace window keeps the chat layout mounted (draft,
 * scroll and active channel survive) and only adds a Reconnecting banner.
 */
import * as React from "react";
import { render, screen } from "@testing-library/react";

type Connection = {
  chatConnected: boolean;
  chatReconnecting: boolean;
  failure: null | { kind: string };
  retryConnection: () => void;
};
let connection: Connection;
const layoutMounts = jest.fn();

jest.mock("../../providers/StreamProvider", () => ({
  useStreamConnection: () => connection,
}));
jest.mock("../../components/stream/StreamChatScope", () => ({
  StreamChatScope: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
jest.mock("../../components/chat/ChatLayout", () => ({
  ChatLayout: () => {
    React.useEffect(() => {
      layoutMounts();
    }, []);
    return <div data-testid="chat-layout" />;
  },
}));
jest.mock("../../components/chat/ChatUnavailable", () => ({
  ChatUnavailable: () => <div data-testid="chat-unavailable" />,
}));
jest.mock("../../components/dashboard/DashboardSkeletons", () => ({
  ChatSkeletonPanes: () => <div data-testid="chat-skeleton" />,
}));

import { ChatSurface } from "@/components/chat/ChatSurface";

const base: Connection = {
  chatConnected: true,
  chatReconnecting: false,
  failure: null,
  retryConnection: jest.fn(),
};

describe("ChatSurface", () => {
  it("keeps the layout mounted through a reconnect and shows a banner", () => {
    connection = base;
    const view = render(<ChatSurface />);
    const layout = screen.getByTestId("chat-layout");

    connection = { ...base, chatConnected: false, chatReconnecting: true };
    view.rerender(<ChatSurface />);

    expect(screen.getByTestId("chat-layout")).toBe(layout);
    expect(layoutMounts).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting");
    expect(screen.queryByTestId("chat-skeleton")).not.toBeInTheDocument();
  });

  it("falls back to the skeleton once the grace window has passed", () => {
    connection = { ...base, chatConnected: false, chatReconnecting: false };
    render(<ChatSurface />);
    expect(screen.getByTestId("chat-skeleton")).toBeInTheDocument();
  });

  it("shows the failure before anything else", () => {
    connection = { ...base, failure: { kind: "retryable" } };
    render(<ChatSurface />);
    expect(screen.getByTestId("chat-unavailable")).toBeInTheDocument();
  });
});
