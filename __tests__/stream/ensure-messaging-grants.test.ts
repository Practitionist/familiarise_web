/**
 * @jest-environment node
 */

const mockGetChannelType = jest.fn();
const mockUpdateChannelType = jest.fn();

jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: jest.fn(() => true),
  getStreamChatClient: jest.fn(() => ({
    getChannelType: mockGetChannelType,
    updateChannelType: mockUpdateChannelType,
  })),
}));

import {
  MESSAGING_USER_REVOKED_GRANTS,
  intendedMessagingGrants,
} from "../../lib/stream/control-plane-contract";
import { ensureMessagingGrants } from "../../scripts/stream/ensure-messaging-grants";

const KEPT = [
  "read-channel",
  "send-message",
  "remove-own-channel-membership-owner",
  "update-channel-members",
  "delete-attachment-owner",
];

const live = () => ({
  user: [...KEPT, ...MESSAGING_USER_REVOKED_GRANTS],
  admin: ["truncate-channel", "update-channel-members-owner"],
});

beforeEach(() => jest.clearAllMocks());

describe("intendedMessagingGrants", () => {
  it("removes exactly the five owner grants from user and preserves every other grant", () => {
    const grants = live();
    expect(intendedMessagingGrants(grants)).toEqual({
      user: KEPT,
      admin: grants.admin,
    });
    expect(MESSAGING_USER_REVOKED_GRANTS).toHaveLength(5);
  });
});

describe("ensureMessagingGrants", () => {
  it("writes nothing on a dry run", async () => {
    mockGetChannelType.mockResolvedValue({ grants: live() });
    expect(await ensureMessagingGrants({ apply: false })).toBe(0);
    expect(mockUpdateChannelType).not.toHaveBeenCalled();
  });

  it("applies only the user role, derived from the live list", async () => {
    mockGetChannelType
      .mockResolvedValueOnce({ grants: live() })
      .mockResolvedValueOnce({ grants: { user: KEPT, admin: live().admin } });
    expect(await ensureMessagingGrants({ apply: true })).toBe(0);
    expect(mockUpdateChannelType).toHaveBeenCalledWith("messaging", {
      grants: { user: KEPT },
    });
  });

  it("fails when Stream still stores an owner grant after the write", async () => {
    mockGetChannelType.mockResolvedValue({ grants: live() });
    expect(await ensureMessagingGrants({ apply: true })).toBe(1);
  });

  it("is a no-op when the grants are already intended", async () => {
    mockGetChannelType.mockResolvedValue({
      grants: { user: KEPT, admin: live().admin },
    });
    expect(await ensureMessagingGrants({ apply: true })).toBe(0);
    expect(mockUpdateChannelType).not.toHaveBeenCalled();
  });
});
