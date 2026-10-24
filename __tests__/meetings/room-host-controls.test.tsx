/**
 * Mobile-safe screen share and the host's mute-everyone control.
 */
import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

let capabilities: string[] = [];
const toast = jest.fn();
const call = { muteAllUsers: jest.fn() };

jest.mock("../../components/ui/use-toast", () => ({
  toast: (...args: unknown[]) => toast(...args),
  useToast: () => ({ toast }),
}));
jest.mock("@stream-io/video-react-sdk", () => ({
  OwnCapability: { MUTE_USERS: "mute-users" },
  ScreenShareButton: () => <div data-testid="screen-share" />,
  useCall: () => call,
  useCallStateHooks: () => ({
    useHasPermissions: (...wanted: string[]) =>
      wanted.every((capability) => capabilities.includes(capability)),
  }),
}));

import { MuteAllButton } from "../../app/meetings/[id]/components/MuteAllButton";
import { ScreenShareControl } from "../../app/meetings/[id]/components/ScreenShareControl";

const originalMediaDevices = Object.getOwnPropertyDescriptor(
  navigator,
  "mediaDevices",
);

function setMediaDevices(value: unknown) {
  Object.defineProperty(navigator, "mediaDevices", {
    value,
    configurable: true,
  });
}

afterEach(() => {
  if (originalMediaDevices) {
    Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  } else {
    Reflect.deleteProperty(navigator, "mediaDevices");
  }
});

describe("ScreenShareControl", () => {
  it("is hidden where the browser cannot capture a screen", () => {
    setMediaDevices({});
    const { container } = render(<ScreenShareControl />);
    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("screen-share")).toBeNull();
  });

  it("is hidden when there is no mediaDevices at all", () => {
    setMediaDevices(undefined);
    render(<ScreenShareControl />);
    expect(screen.queryByTestId("screen-share")).toBeNull();
  });

  it("renders the SDK button when getDisplayMedia exists", () => {
    setMediaDevices({ getDisplayMedia: jest.fn() });
    render(<ScreenShareControl />);
    expect(screen.getByTestId("screen-share")).toBeTruthy();
  });
});

describe("MuteAllButton", () => {
  beforeEach(() => {
    call.muteAllUsers.mockReset();
    call.muteAllUsers.mockResolvedValue({});
  });

  it("renders nothing without the mute-users capability", () => {
    capabilities = ["send-audio"];
    render(<MuteAllButton />);
    expect(screen.queryByTestId("mute-all-button")).toBeNull();
  });

  it("asks for confirmation, then mutes everyone's audio and says so", async () => {
    capabilities = ["mute-users"];
    render(<MuteAllButton />);

    fireEvent.click(screen.getByTestId("mute-all-button"));
    expect(call.muteAllUsers).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByTestId("mute-all-confirm"));
    });

    expect(call.muteAllUsers).toHaveBeenCalledWith("audio");
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Everyone is muted" }),
    );
  });

  it("reports a failed mute instead of claiming success", async () => {
    capabilities = ["mute-users"];
    call.muteAllUsers.mockRejectedValueOnce(new Error("nope"));
    render(<MuteAllButton />);

    fireEvent.click(screen.getByTestId("mute-all-button"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("mute-all-confirm"));
    });

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not mute everyone",
        variant: "destructive",
      }),
    );
  });
});
