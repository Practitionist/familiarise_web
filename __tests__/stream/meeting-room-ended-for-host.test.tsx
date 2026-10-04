/**
 * The room after someone ELSE ends the call, seen from the hosting side.
 *
 * On `call.ended` the SDK leaves: `callingState` becomes LEFT and the
 * participant list is emptied, while `participantCount` keeps its last SFU
 * value. The room used to exempt the host from the ended screen — the host
 * being assumed to be the one pressing End, and already on their way out — so
 * a co-host (#1580), a second tab, or an SFU max-duration end left the host on
 * a live-looking room: header "2 participants", ticking clock, full control
 * bar, and a SpeakerLayout over zero participants, which paints nothing.
 *
 * The assertion is on the branch, not the pixels: a host on an ended call gets
 * the ended screen and no layout at all, exactly like a guest does.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const push = jest.fn();
let sessionUser: Record<string, unknown> | null = null;
let callingState = "left";
let endedAt: Date | undefined;
let isCallLive = true;
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
  on: jest.fn(() => () => {}),
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
      SEND_AUDIO: "send-audio",
      SEND_VIDEO: "send-video",
    },
    SfuModels: { ConnectionQuality: { POOR: 1 }, TrackType: { VIDEO: 2 } },
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

describe("the room after the call is ended by someone else", () => {
  it("shows a host the ended screen, not an empty stage", async () => {
    // The owner: the host by every definition the room has had. A co-host is
    // one only from #1580 on, and the fix is the same branch for both.
    sessionUser = { id: "owner", role: "CONSULTANT" };
    callingState = "left";
    endedAt = new Date("2026-09-12T18:16:30.317Z");

    await render();

    expect(host.textContent).toContain("The call has ended");
    expect(host.querySelector('[data-testid="speaker-layout"]')).toBeNull();
    expect(host.querySelector('[data-testid="grid-layout"]')).toBeNull();
    expect(host.textContent).not.toContain("2 participants");
  });

  it("still shows a guest the ended-by-host screen", async () => {
    sessionUser = { id: "guest", role: "CONSULTEE" };
    callingState = "left";
    endedAt = new Date("2026-09-12T18:16:30.317Z");

    await render();

    expect(host.textContent).toContain("The call has been ended by the host");
    expect(host.querySelector('[data-testid="speaker-layout"]')).toBeNull();
  });

  it("renders the stage for a host while the call is live", async () => {
    // The control: the same host, same custom data, call not ended.
    sessionUser = { id: "owner", role: "CONSULTANT" };
    callingState = "joined";
    endedAt = undefined;

    await render();

    expect(host.querySelector('[data-testid="speaker-layout"]')).not.toBeNull();
    expect(host.textContent).toContain("2 participants");
    expect(call.setIncomingVideoEnabled).toHaveBeenCalledWith(true);
    expect(call.setPreferredIncomingVideoResolution).toHaveBeenCalledWith({
      width: 1280,
      height: 720,
    });
  });

  it("applies the 480p incoming video cap on mount for 1:1 consultations", async () => {
    sessionUser = { id: "owner", role: "CONSULTANT" };
    callingState = "joined";
    endedAt = undefined;
    custom.appointmentType = "CONSULTATION";

    await render();

    expect(call.setIncomingVideoEnabled).toHaveBeenCalledWith(true);
    expect(call.setPreferredIncomingVideoResolution).toHaveBeenCalledWith({
      width: 640,
      height: 480,
    });
  });
});

describe("MeetingRoom backstage isolation for 1-to-Many sessions", () => {
  beforeEach(() => {
    callingState = "joined";
    endedAt = undefined;
    callSettings = {
      backstage: { enabled: true, join_ahead_time_seconds: 900 },
    };
  });

  it("hides CallLayout from waiting attendees before Go Live while keeping StageControls visible", async () => {
    sessionUser = { id: "guest", role: "CONSULTEE" };
    isCallLive = false;

    await render();

    expect(
      host.querySelector('[data-testid="backstage-waiting-room"]'),
    ).not.toBeNull();
    expect(host.querySelector('[data-testid="speaker-layout"]')).toBeNull();
    expect(host.querySelector('[data-testid="grid-layout"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="backstage-banner"]'),
    ).not.toBeNull();
    expect(host.textContent).toContain(
      "Waiting for host to start the live session...",
    );
  });

  it("keeps CallLayout and Go Live controls visible for the host during backstage prep", async () => {
    sessionUser = { id: "owner", role: "CONSULTANT" };
    isCallLive = false;

    await render();

    expect(
      host.querySelector('[data-testid="backstage-waiting-room"]'),
    ).toBeNull();
    expect(host.querySelector('[data-testid="speaker-layout"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="go-live-button"]')).not.toBeNull();
  });

  it("renders CallLayout for attendees once the host transitions the call to live", async () => {
    sessionUser = { id: "guest", role: "CONSULTEE" };
    isCallLive = true;

    await render();

    expect(
      host.querySelector('[data-testid="backstage-waiting-room"]'),
    ).toBeNull();
    expect(host.querySelector('[data-testid="speaker-layout"]')).not.toBeNull();
  });
});
