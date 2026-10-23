/**
 * Support and system messages in the booking chat: system lines render as a
 * centred muted row with no actions, support posts carry a badge keyed on the
 * author id, and neither offers edit/delete/report.
 */
import * as React from "react";
import { render, screen } from "@testing-library/react";

import {
  SUPPORT_STREAM_USER_ID,
  SUPPORT_STREAM_USER_NAME,
} from "@/lib/stream/support-user";

let currentMessage: Record<string, unknown>;

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
  useMessageContext: () => ({ message: currentMessage }),
  useMessageComposerController: () => ({ setQuotedMessage: jest.fn() }),
}));

import { CustomMessage } from "@/components/chat/CustomMessage";
import { SystemMessage } from "@/components/chat/SystemMessage";

const createdAt = new Date("2026-10-22T10:00:00Z");

function message(overrides: Record<string, unknown>) {
  currentMessage = {
    id: "m1",
    type: "regular",
    text: "Hello",
    created_at: createdAt,
    user: { id: "them", name: "Them" },
    ...overrides,
  };
}

const supportUser = {
  id: SUPPORT_STREAM_USER_ID,
  name: SUPPORT_STREAM_USER_NAME,
};

describe("system messages", () => {
  it("render centred and muted with no actions", () => {
    message({
      type: "system",
      text: "Familiarise Support joined the chat",
      user: supportUser,
      event: "support_joined",
    });
    render(<CustomMessage />);

    const row = screen.getByTestId("system-message");
    expect(row).toHaveTextContent("Familiarise Support joined the chat");
    expect(row).toHaveClass("justify-center");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("render through the MessageSystem slot too", () => {
    render(
      <SystemMessage
        message={{ text: "Familiarise Support left the chat", user: undefined }}
      />,
    );
    expect(screen.getByTestId("system-message")).toHaveTextContent(
      "Familiarise Support left the chat",
    );
  });

  it("render nothing when empty", () => {
    const { container } = render(
      <SystemMessage message={{ text: "  ", user: undefined }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("support messages", () => {
  it("carry the Familiarise Support badge", () => {
    message({ user: supportUser, support_message: true });
    render(<CustomMessage />);
    expect(screen.getByText(SUPPORT_STREAM_USER_NAME)).toBeInTheDocument();
  });

  it("offer no edit, delete or report menu", () => {
    message({ user: supportUser, support_message: true });
    render(<CustomMessage />);
    expect(
      screen.queryByRole("button", { name: "More message options" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Report Message")).not.toBeInTheDocument();
    expect(screen.queryByText("Edit")).not.toBeInTheDocument();
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
  });

  it("are recognised by author id, not a user-writable flag", () => {
    message({ user: { id: "them", name: "Them" }, support_message: true });
    render(<CustomMessage />);
    expect(
      screen.queryByText(SUPPORT_STREAM_USER_NAME),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "More message options" }),
    ).toBeInTheDocument();
  });
});

describe("ordinary messages", () => {
  it("keep the more-options menu", () => {
    message({});
    render(<CustomMessage />);
    expect(
      screen.getByRole("button", { name: "More message options" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Them")).toBeInTheDocument();
  });
});
