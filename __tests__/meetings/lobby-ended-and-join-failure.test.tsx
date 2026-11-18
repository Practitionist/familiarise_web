/**
 * The lobby after the call ends under a waiting participant, and the faces a
 * failed `call.join()` gets there.
 */
import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

let endedAt: Date | undefined;
const call = {
  cid: "default:c1",
  id: "c1",
  state: { callingState: "idle", endedAt: undefined as Date | undefined },
  join: jest.fn(),
};

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn() }),
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: { user: { timezone: "UTC" } } }),
}));
jest.mock("../../lib/stream/audio-level", () => ({
  createMicLevelMeter: () => () => {},
  SPEAKING_THRESHOLD: 0.1,
}));
jest.mock("../../app/meetings/[id]/session-info", () => ({
  formatScheduledAt: () => null,
  sessionHeading: () => "Session",
  sessionSubheading: () => null,
  useSessionInfo: () => ({
    typeLabel: null,
    startsAt: null,
    durationMinutes: 0,
  }),
  useSessionClock: () => ({ phase: "in-progress", status: null }),
}));
jest.mock("../../app/meetings/[id]/components/RecordingConsentNotice", () => ({
  useRecordingConsent: () => ({ loading: false, satisfied: true, node: null }),
}));
jest.mock("@stream-io/video-react-sdk", () => ({
  ...jest.requireActual("@stream-io/video-react-sdk"),
  useCall: () => call,
  VideoPreview: () => null,
  useCallStateHooks: () => {
    const device = {
      isEnabled: false,
      mediaStream: undefined,
      hasBrowserPermission: true,
      devices: [],
      camera: { disable: jest.fn(), toggle: jest.fn(), select: jest.fn() },
      microphone: { enable: jest.fn(), toggle: jest.fn(), select: jest.fn() },
    };
    return {
      useMicrophoneState: () => device,
      useCameraState: () => device,
      useCallEndedAt: () => endedAt,
    };
  },
}));

const pingHostLive = jest.fn();
jest.mock("../../app/meetings/[id]/host-live-ping", () => ({
  pingHostLive: (...a: unknown[]) => pingHostLive(...a),
}));

import MeetingSetup from "../../app/meetings/[id]/components/MeetingSetup";

const SFU_PARTICIPANT_LIMIT_REACHED = 301;

function setup(
  role: "host" | "participant",
  onCallEnded = jest.fn(),
  coPresenter = false,
) {
  const view = render(
    <MeetingSetup
      setIsSetupComplete={jest.fn()}
      meetingId="c1"
      role={role}
      coPresenter={coPresenter}
      onCallEnded={onCallEnded}
    />,
  );
  return { ...view, onCallEnded };
}

beforeEach(() => {
  endedAt = undefined;
  call.state.endedAt = undefined;
  call.join.mockReset();
  pingHostLive.mockReset();
});

describe("the lobby when the call ends while waiting", () => {
  it("swaps Join for the ended panel and asks the server once per ended call", () => {
    endedAt = new Date("2026-10-24T10:00:00Z");
    const { onCallEnded, rerender } = setup("participant");

    expect(screen.getByTestId("lobby-ended-panel")).toBeTruthy();
    expect(screen.queryByText("Join now")).toBeNull();
    expect(screen.queryByTestId("lobby-reopen-button")).toBeNull();
    expect(onCallEnded).toHaveBeenCalledTimes(1);

    rerender(
      <MeetingSetup
        setIsSetupComplete={jest.fn()}
        meetingId="c1"
        role="participant"
        onCallEnded={onCallEnded}
      />,
    );
    expect(onCallEnded).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("lobby-ended-check-again"));
    expect(onCallEnded).toHaveBeenCalledTimes(2);
  });

  it("offers the host a reopen", () => {
    endedAt = new Date("2026-10-24T10:00:00Z");
    setup("host");
    expect(screen.getByTestId("lobby-reopen-button")).toBeTruthy();
  });

  it("keeps Join for a live call", () => {
    const { onCallEnded } = setup("participant");
    expect(screen.queryByTestId("lobby-ended-panel")).toBeNull();
    expect(screen.getByText("Join now")).toBeTruthy();
    expect(onCallEnded).not.toHaveBeenCalled();
  });
});

describe("a failed join from the lobby", () => {
  async function joinFailingWith(error: unknown) {
    call.join.mockRejectedValueOnce(error);
    jest.spyOn(console, "error").mockImplementation(() => {});
    setup("participant");
    await act(async () => {
      fireEvent.click(screen.getByText("Join now"));
    });
  }

  it("shows the full-session face when Stream refuses a full call", async () => {
    await joinFailingWith(
      Object.assign(new Error("Join Error"), {
        errorEvent: { error: { code: SFU_PARTICIPANT_LIMIT_REACHED } },
      }),
    );
    const card = screen.getByTestId("join-failure-card");
    expect(card.dataset.failureKind).toBe("room_full");
    expect(card.textContent).toContain("This session is full");
  });

  it("shows the provider-unavailable face with a Retry that joins again", async () => {
    await joinFailingWith(new TypeError("Failed to fetch"));
    expect(screen.getByTestId("join-failure-card").dataset.failureKind).toBe(
      "provider_unavailable",
    );

    call.join.mockResolvedValueOnce(undefined);
    await act(async () => {
      fireEvent.click(screen.getByTestId("join-retry"));
    });
    expect(call.join).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("join-failure-card")).toBeNull();
  });
});

describe("the host-is-live ping", () => {
  async function clickJoin() {
    await act(async () => {
      fireEvent.click(screen.getByText("Join now"));
    });
  }

  it("fires once the host's call join resolves, never on the lobby load", async () => {
    setup("host");
    expect(pingHostLive).not.toHaveBeenCalled();

    call.join.mockResolvedValueOnce(undefined);
    await clickJoin();
    expect(pingHostLive).toHaveBeenCalledTimes(1);
    expect(pingHostLive).toHaveBeenCalledWith("c1");
  });

  it("stays silent when the host's join fails, and for an attendee", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    call.join.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const host = setup("host");
    await clickJoin();
    host.unmount();

    call.join.mockResolvedValueOnce(undefined);
    setup("participant");
    await clickJoin();
    expect(pingHostLive).not.toHaveBeenCalled();
  });

  it("stays silent for a co-presenter: only the plan's host announces the session", async () => {
    call.join.mockResolvedValueOnce(undefined);
    setup("host", jest.fn(), true);
    await clickJoin();
    expect(call.join).toHaveBeenCalledTimes(1);
    expect(pingHostLive).not.toHaveBeenCalled();
  });
});
