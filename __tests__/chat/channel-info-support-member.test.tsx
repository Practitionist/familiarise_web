/**
 * Familiarise Support is a visible member, but it is not a party: while it is
 * in an event channel the owner can't remove anyone (Stream refuses it too),
 * and in a DM it is never the user that "Report" or "Block" targets.
 */
import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";

import {
  SUPPORT_STREAM_USER_ID,
  SUPPORT_STREAM_USER_NAME,
} from "@/lib/stream/support-user";

const flagUser = jest.fn();
let viewerId = "host";

jest.mock("stream-chat-react", () => ({
  useChatContext: () => ({
    client: { userID: viewerId, flagUser },
    setActiveChannel: jest.fn(),
  }),
}));
jest.mock("next/image", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../../actions/stream/chat/member.action", () => ({
  addMemberToChannel: jest.fn(),
}));
const removeUserFromEventChannel = jest.fn();
jest.mock("../../actions/stream/chat/event-channel.action", () => ({
  removeUserFromEventChannel: (...args: unknown[]) =>
    removeUserFromEventChannel(...args),
}));
jest.mock("../../components/ui/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("../../hooks/use-media-query", () => ({
  useMediaQuery: () => true,
}));
jest.mock("../../components/chat/AddMembersDialog", () => ({
  AddMembersDialog: () => null,
}));

import type { Channel } from "stream-chat";
import { ChannelInfoAndManageDialog } from "@/components/chat/ChannelInfoAndManageDialog";

function fakeChannel(
  type: "messaging" | "team",
  id: string,
  members: Array<{ id: string; name: string }>,
  creatorId: string,
) {
  return {
    type,
    id,
    cid: `${type}:${id}`,
    data: { name: "Yoga basics", created_by: { id: creatorId } },
    state: {
      members: Object.fromEntries(
        members.map((user) => [user.id, { user_id: user.id, user }]),
      ),
    },
    muteStatus: () => ({ muted: false }),
    removeMembers: jest.fn(),
  } as unknown as Channel;
}

function openDialog() {
  fireEvent.click(
    screen.getByRole("button", { name: "Channel details and settings" }),
  );
}

describe("event channel member list", () => {
  beforeEach(() => {
    viewerId = "host";
  });

  function openMembers(members: Array<{ id: string; name: string }>) {
    const channel = fakeChannel("team", "webinar-abc", members, "host");
    render(<ChannelInfoAndManageDialog channel={channel} />);
    openDialog();
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Members/ }), {
      button: 0,
    });
    return screen.getByRole("tabpanel");
  }

  it("lets the owner remove attendees when support is not in the channel", () => {
    const panel = openMembers([
      { id: "host", name: "Host" },
      { id: "attendee", name: "Asha" },
    ]);
    expect(
      within(panel).getAllByRole("button", {
        name: "Remove Asha from this channel",
      }).length,
    ).toBeGreaterThan(0);
  });

  it("opens the conduct removal dialog, not a chat-only kick", async () => {
    const channel = fakeChannel(
      "team",
      "webinar-abc",
      [
        { id: "host", name: "Host" },
        { id: "attendee", name: "Asha" },
      ],
      "host",
    );
    render(<ChannelInfoAndManageDialog channel={channel} />);
    openDialog();
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Members/ }), {
      button: 0,
    });
    fireEvent.click(
      within(screen.getByRole("tabpanel")).getAllByRole("button", {
        name: "Remove Asha from this channel",
      })[0],
    );
    expect(await screen.findByText("Remove Asha?")).toBeInTheDocument();
    // A removal needs a reason; nothing is sent until one is chosen.
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(removeUserFromEventChannel).not.toHaveBeenCalled();
    expect(channel.removeMembers).not.toHaveBeenCalled();
  });

  it("hides every remove control while support is in the channel", () => {
    const panel = openMembers([
      { id: "host", name: "Host" },
      { id: "attendee", name: "Asha" },
      { id: SUPPORT_STREAM_USER_ID, name: SUPPORT_STREAM_USER_NAME },
    ]);
    expect(
      within(panel).queryByRole("button", {
        name: "Remove Asha from this channel",
      }),
    ).not.toBeInTheDocument();
    expect(
      within(panel).queryByRole("button", {
        name: `Remove ${SUPPORT_STREAM_USER_NAME} from this channel`,
      }),
    ).not.toBeInTheDocument();
    expect(within(panel).getAllByText("Staff").length).toBeGreaterThan(0);
  });
});

describe("DM with support present", () => {
  beforeEach(() => {
    viewerId = "me";
    flagUser.mockResolvedValue({});
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })) as unknown as typeof fetch;
  });

  function supportDm() {
    // Support listed first so a naive "first member that isn't me" picks it.
    return fakeChannel(
      "messaging",
      "dm-me-them",
      [
        { id: SUPPORT_STREAM_USER_ID, name: SUPPORT_STREAM_USER_NAME },
        { id: "me", name: "Me" },
        { id: "them", name: "Them" },
      ],
      "me",
    );
  }

  it("stays a 1:1 and reports the counterparty, not support", async () => {
    render(<ChannelInfoAndManageDialog channel={supportDm()} />);
    openDialog();

    expect(screen.getByText("Direct Message")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Report User/ }));
    await screen.findByRole("button", { name: /Report User/ });
    expect(flagUser).toHaveBeenCalledWith("them", { reason: "user_report" });
  });

  it("hides Clear Chat while support is reviewing", () => {
    render(<ChannelInfoAndManageDialog channel={supportDm()} />);
    openDialog();
    expect(
      screen.queryByRole("button", { name: /Clear Chat/ }),
    ).not.toBeInTheDocument();
  });
});
