/**
 * The room of someone taken out of a session that goes on without them. The
 * media server closes their connection with the reason "kicked"; the room says
 * they were removed and offers the way home, with no rejoin. A call that ended
 * for everyone keeps the ended screen and its rejoin.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Listener = (event: { reason: number }) => void;
const listeners = new Map<string, Listener>();
const ENDED = 1;
const KICKED = 3;
const push = jest.fn();
let sessionUser: Record<string, unknown> | null = null;
let callingState = "left";
let endedAt: Date | undefined;
let isCallLive = true;
let canMuteUsers = false;
let callSettings: Record<string, unknown> | undefined;
const custom: Record<string, unknown> = {
  hostUserIds: ["owner", "co-host"],
  consultantUserId: "owner",
  consulteeUserId: "guest",
  sessionStartsAt: "2026-09-12T17:54:26.718Z",
  sessionEndsAt: "2026-09-12T18:54:26.718Z",
  appointmentType: "WEBINAR",
};
const call = {
  id: "slot-A",
  setDisconnectionTimeout: jest.fn(),
  setIncomingVideoEnabled: jest.fn(),
  setPreferredIncomingVideoResolution: jest.fn(),
  on: jest.fn((event: string, listener: Listener) => {
    listeners.set(event, listener);
    return () => {};
  }),
  state: { recording: false },
};

jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: sessionUser ? { user: sessionUser } : null }),
}));
jest.mock("../../lib/stream/media-teardown", () => ({
  leaveCallAndReleaseMedia: () => Promise.resolve(),
}));
jest.mock("@stream-io/video-react-sdk", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const stub = (testId: string) => () =>
    React.createElement("div", { "data-testid": testId });
  return {
    CallingState: {
      IDLE: "idle",
      JOINED: "joined",
      JOINING: "joining",
      LEFT: "left",
      MIGRATING: "migrating",
      OFFLINE: "offline",
      RECONNECTING: "reconnecting",
      RECONNECTING_FAILED: "reconnecting-failed",
      RINGING: "ringing",
      UNKNOWN: "unknown",
    },
    OwnCapability: {
      MUTE_USERS: "mute-users",
      SEND_AUDIO: "send-audio",
      SEND_VIDEO: "send-video",
    },
    SfuModels: {
      ConnectionQuality: { POOR: 1 },
      TrackType: { VIDEO: 2 },
      CallEndedReason: { ENDED: 1, KICKED: 3 },
    },
    useCall: () => call,
    useCallStateHooks: () => ({
      useCallCallingState: () => callingState,
      useCallEndedAt: () => endedAt,
      useParticipantCount: () => 2,
      useCallCustomData: () => custom,
      useParticipants: () => [],
      useLocalParticipant: () => undefined,
      useIncomingVideoSettings: () => ({ enabled: true }),
      useIsCallLive: () => isCallLive,
      useCallSettings: () => callSettings,
      useOwnCapabilities: () => [],
      useHasPermissions: () => canMuteUsers,
    }),
    SpeakerLayout: stub("speaker-layout"),
    PaginatedGridLayout: stub("grid-layout"),
    CallParticipantsList: stub("participants-list"),
    CallStatsButton: stub("stats"),
    SpeakingWhileMutedNotification: ({
      children,
    }: {
      children: React.ReactNode;
    }) => React.createElement(React.Fragment, null, children),
    ToggleAudioPublishingButton: stub("mic"),
    ToggleVideoPublishingButton: stub("camera"),
    ReactionsButton: stub("reactions"),
    ScreenShareButton: stub("screen-share"),
  };
});

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import MeetingRoom from "../../app/meetings/[id]/components/MeetingRoom";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  push.mockReset();
  call.setIncomingVideoEnabled.mockReset();
  call.setPreferredIncomingVideoResolution.mockReset();
  isCallLive = true;
  canMuteUsers = false;
  callSettings = undefined;
  custom.appointmentType = "WEBINAR";
  global.fetch = jest.fn(() =>
    Promise.resolve({ ok: false, status: 404 }),
  ) as unknown as typeof fetch;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render() {
  await act(async () => {
    root.render(<MeetingRoom onRejoin={() => {}} />);
  });
}

/** The media server closes this viewer's connection; the SDK marks the call ended and leaves. */
async function closeWith(reason: number) {
  await render();
  endedAt = new Date();
  callingState = "left";
  await act(async () => {
    listeners.get("callEnded")?.({ reason });
  });
  await render();
}

describe("the room of someone taken out of a session", () => {
  beforeEach(() => {
    sessionUser = { id: "co-host", role: "CONSULTANT" };
    callingState = "joined";
    endedAt = undefined;
  });

  it("says they were removed and offers the way home, with no rejoin", async () => {
    await closeWith(KICKED);

    expect(host.textContent).toContain("You were removed from this session.");
    expect(host.textContent).toContain("Return to Home");
    expect(host.textContent).not.toMatch(/rejoin/i);
    expect(host.textContent).not.toContain("The call has ended");
    expect(host.querySelector('[data-testid="speaker-layout"]')).toBeNull();
  });

  it("keeps the ended screen and its rejoin when the call ended for everyone", async () => {
    await closeWith(ENDED);

    expect(host.textContent).toContain("The call has ended");
    expect(host.textContent).toContain("Try to Rejoin");
    expect(host.textContent).not.toContain("removed");
  });
});
