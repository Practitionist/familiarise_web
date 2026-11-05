/**
 * An own message that failed to send says so and offers the SDK's retry; a
 * delivered message and someone else's message show neither.
 */
import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

let currentMessage: Record<string, unknown>;
const handleRetry = jest.fn();

jest.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/consultee/abc/messages",
}));
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("../../hooks/use-media-query", () => ({
  useMediaQuery: () => true,
}));
jest.mock("stream-chat-react", () => ({
  Attachment: () => null,
  useChatContext: () => ({
    client: { userID: "me" },
    channel: { cid: "messaging:dm-me-them" },
  }),
  useMessageContext: () => ({ message: currentMessage, handleRetry }),
  useMessageComposerController: () => ({ setQuotedMessage: jest.fn() }),
}));

import { CustomMessage } from "@/components/chat/CustomMessage";

function message(overrides: Record<string, unknown>) {
  currentMessage = {
    id: "m1",
    type: "regular",
    text: "Hello",
    created_at: new Date("2026-10-22T10:00:00Z"),
    user: { id: "me", name: "Me" },
    status: "received",
    ...overrides,
  };
}

describe("send status on my messages", () => {
  it("marks a failed send and retries it through the SDK", () => {
    message({ status: "failed" });
    render(<CustomMessage />);

    expect(screen.getByRole("alert")).toHaveTextContent("Not sent");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(handleRetry).toHaveBeenCalledWith(currentMessage);
  });

  it("shows a sending indicator while the send is pending", () => {
    message({ status: "sending" });
    render(<CustomMessage />);
    expect(screen.getByText("Sending…")).toBeInTheDocument();
  });

  it("shows neither for a delivered message or another author's", () => {
    message({});
    const { rerender } = render(<CustomMessage />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    message({ status: "failed", user: { id: "them", name: "Them" } });
    rerender(<CustomMessage />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
