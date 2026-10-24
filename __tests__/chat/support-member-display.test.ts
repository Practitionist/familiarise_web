/**
 * Familiarise Support joins a booking chat as a visible member. It must never
 * turn a 1:1 into a group DM, never count as the counterparty, and its
 * presence is read from membership alone.
 */

import type { Channel } from "stream-chat";

import {
  channelHasSupportMember,
  getChannelDisplayInfo,
  isUsableDmChannel,
  membersIncludeSupport,
} from "@/components/chat/utils/channelUtils";
import {
  SUPPORT_STREAM_USER_ID,
  SUPPORT_STREAM_USER_NAME,
} from "@/lib/stream/support-user";

function fakeChannel(
  type: "messaging" | "team",
  memberIds: string[],
  data: Record<string, unknown> = {},
): Channel {
  return {
    type,
    id: `${type}-fixture`,
    cid: `${type}:fixture`,
    data,
    state: {
      members: Object.fromEntries(
        memberIds.map((id) => [
          id,
          {
            user_id: id,
            user: {
              id,
              name:
                id === SUPPORT_STREAM_USER_ID
                  ? SUPPORT_STREAM_USER_NAME
                  : `User ${id}`,
            },
          },
        ]),
      ),
    },
  } as unknown as Channel;
}

describe("support membership in a DM", () => {
  it("keeps a DM with support a 1:1 named after the counterparty", () => {
    const info = getChannelDisplayInfo(
      fakeChannel("messaging", ["me", "them", SUPPORT_STREAM_USER_ID]),
      "me",
    );
    expect(info.isGroupDM).toBe(false);
    expect(info.displayName).toBe("User them");
    expect(info.memberCount).toBe(1);
    expect(info.hasSupport).toBe(true);
  });

  it("reports no support on an ordinary DM", () => {
    const info = getChannelDisplayInfo(
      fakeChannel("messaging", ["me", "them"]),
      "me",
    );
    expect(info.hasSupport).toBe(false);
  });

  it("still detects a real group DM alongside support", () => {
    const info = getChannelDisplayInfo(
      fakeChannel("messaging", ["me", "a", "b", SUPPORT_STREAM_USER_ID]),
      "me",
    );
    expect(info.isGroupDM).toBe(true);
    expect(info.memberCount).toBe(2);
    expect(info.fullGroupName).not.toContain(SUPPORT_STREAM_USER_NAME);
  });

  it("never names support as the counterparty", () => {
    const info = getChannelDisplayInfo(
      fakeChannel("messaging", ["me", SUPPORT_STREAM_USER_ID]),
      "me",
    );
    expect(info.displayName).not.toBe(SUPPORT_STREAM_USER_NAME);
    expect(info.displayName).toBe("Unavailable conversation");
  });

  it("does not let support make a DM usable on its own", () => {
    expect(
      isUsableDmChannel(
        fakeChannel("messaging", ["me", SUPPORT_STREAM_USER_ID]),
      ),
    ).toBe(false);
    expect(
      isUsableDmChannel(
        fakeChannel("messaging", ["me", "them", SUPPORT_STREAM_USER_ID]),
      ),
    ).toBe(true);
  });
});

describe("support membership in a team channel", () => {
  it("flags hasSupport", () => {
    const info = getChannelDisplayInfo(
      fakeChannel("team", ["host", "a", SUPPORT_STREAM_USER_ID], {
        name: "Webinar",
      }),
      "host",
    );
    expect(info.hasSupport).toBe(true);
    expect(info.displayName).toBe("Webinar");
  });
});

describe("presence is membership only", () => {
  it("ignores channel data that claims support", () => {
    const channel = fakeChannel("messaging", ["me", "them"], {
      support_active: true,
    });
    expect(channelHasSupportMember(channel)).toBe(false);
  });

  it("matches on user_id when the user object is absent", () => {
    expect(
      membersIncludeSupport({
        [SUPPORT_STREAM_USER_ID]: { user_id: SUPPORT_STREAM_USER_ID },
      }),
    ).toBe(true);
  });

  it("handles missing members", () => {
    expect(membersIncludeSupport(undefined)).toBe(false);
  });
});
