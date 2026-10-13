/**
 * In-call recording decline: only a non-host in a recorded 1:1 sees the
 * control, and confirming it posts one DECLINED decision to the consent route.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const toast = jest.fn();
const custom: Record<string, unknown> = { appointmentType: "CONSULTATION" };
const call = {
  id: "call-1",
  on: jest.fn(() => () => {}),
  state: { recording: true },
};

jest.mock("../../components/ui/use-toast", () => ({
  toast: (...args: unknown[]) => toast(...args),
  useToast: () => ({ toast }),
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "guest" } } }),
}));
jest.mock("@stream-io/video-react-sdk", () => ({
  useCall: () => call,
  useCallStateHooks: () => ({ useCallCustomData: () => custom }),
}));

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import RecordingControls from "../../app/meetings/[id]/components/RecordingControls";

let host: HTMLDivElement;
let root: Root;
let fetchMock: jest.Mock;

function render(isHost: boolean) {
  act(() => {
    root.render(
      <RecordingControls
        meetingId="meeting-1"
        recordingEnabled
        showOnlyIndicator
        isHost={isHost}
      />,
    );
  });
}

const findButton = (label: string) =>
  Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );

async function openAndConfirm(clicks = 1) {
  act(() => findButton("Stop recording me")!.click());
  const action = findButton("Stop and discard")!;
  await act(async () => {
    for (let i = 0; i < clicks; i++) action.click();
  });
  return action;
}

beforeEach(() => {
  toast.mockReset();
  call.state.recording = true;
  custom.appointmentType = "CONSULTATION";
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

it("shows the control only to a non-host in a recorded 1:1", () => {
  render(true);
  expect(findButton("Stop recording me")).toBeUndefined();

  render(false);
  expect(findButton("Stop recording me")).toBeDefined();

  custom.appointmentType = "WEBINAR";
  render(false);
  expect(findButton("Stop recording me")).toBeUndefined();

  custom.appointmentType = "CONSULTATION";
  call.state.recording = false;
  act(() => root.unmount());
  root = createRoot(host);
  render(false);
  expect(findButton("Stop recording me")).toBeUndefined();
});

it("posts one DECLINED decision, toasts the discard and hides the control", async () => {
  let resolve!: (value: unknown) => void;
  fetchMock.mockReturnValue(new Promise((r) => (resolve = r)));
  render(false);

  const action = await openAndConfirm(2);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/meetings/call-1/recording-consent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "DECLINED" }),
    },
  );
  expect(action.disabled).toBe(true);

  await act(async () => {
    resolve({
      ok: true,
      json: () => Promise.resolve({ recordingStopped: true }),
    });
  });
  expect(toast).toHaveBeenCalledWith({
    title: "Recording stopped",
    description: "It will be discarded at your request.",
  });
  expect(findButton("Stop recording me")).toBeUndefined();
});

it("surfaces the server message and keeps the control on failure", async () => {
  fetchMock.mockResolvedValue({
    ok: false,
    json: () => Promise.resolve({ error: "Recording could not be stopped" }),
  });
  render(false);

  await openAndConfirm();
  expect(toast).toHaveBeenCalledWith({
    title: "Could not stop the recording",
    description: "Recording could not be stopped",
    variant: "destructive",
  });
  expect(findButton("Stop and discard")?.disabled).toBe(false);
});
