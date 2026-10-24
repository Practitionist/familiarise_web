/**
 * The intervention banner follows channel membership: it shows while the
 * Familiarise Support user is a member and goes when it leaves, re-rendering
 * from the channel-state context the SDK refreshes on member.added/removed.
 */
import * as React from "react";
import { render, screen } from "@testing-library/react";

import {
  SUPPORT_STREAM_USER_ID,
  SUPPORT_STREAM_USER_NAME,
} from "@/lib/stream/support-user";
import { MESSAGE_REVIEW_ARTICLE_HREF } from "@/lib/compliance/purpose-codes";

type Members = Record<string, { user_id: string; user?: { id: string } }>;

let channelState: {
  channel: { state: { members: Members }; data?: Record<string, unknown> };
  members?: Members;
};

jest.mock("stream-chat-react", () => ({
  useChannelStateContext: () => channelState,
}));

import { SupportInterventionBanner } from "@/components/chat/SupportInterventionBanner";

function member(id: string) {
  return { user_id: id, user: { id, name: id } };
}

function setMembers(ids: string[], data: Record<string, unknown> = {}) {
  const members = Object.fromEntries(ids.map((id) => [id, member(id)]));
  channelState = { channel: { state: { members }, data }, members };
}

describe("SupportInterventionBanner", () => {
  it("renders nothing without the support member", () => {
    setMembers(["me", "them"]);
    const { container } = render(<SupportInterventionBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("appears when support joins and disappears when it leaves", () => {
    setMembers(["me", "them"]);
    const { rerender } = render(<SupportInterventionBanner />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    setMembers(["me", "them", SUPPORT_STREAM_USER_ID]);
    rerender(<SupportInterventionBanner />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(
      `${SUPPORT_STREAM_USER_NAME} is in this chat to help with a reported issue. Our team can read this conversation while the issue is open.`,
    );
    expect(
      screen.getByRole("link", { name: "How we review messages" }),
    ).toHaveAttribute("href", MESSAGE_REVIEW_ARTICLE_HREF);

    setMembers(["me", "them"]);
    rerender(<SupportInterventionBanner />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("ignores channel extra data", () => {
    setMembers(["me", "them"], {
      support_active: true,
      support_user_id: SUPPORT_STREAM_USER_ID,
    });
    render(<SupportInterventionBanner />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("falls back to channel.state before the context has members", () => {
    setMembers(["me", SUPPORT_STREAM_USER_ID]);
    channelState = { channel: channelState.channel };
    render(<SupportInterventionBanner />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});
