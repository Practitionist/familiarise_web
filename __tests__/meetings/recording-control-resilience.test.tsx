/**
 * One transient recording-info failure must not remove the host's Record
 * button, and a start that never gets its socket event must not leave the
 * button spinning.
 */
import * as React from "react";
import {
  act,
  render,
  renderHook,
  screen,
  fireEvent,
} from "@testing-library/react";

const toast = jest.fn();
const handlers = new Map<string, () => void>();
const call = {
  id: "call-1",
  get: jest.fn(() => Promise.resolve()),
  on: jest.fn((event: string, handler: () => void) => {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  }),
  state: { recording: false },
};

jest.mock("../../components/ui/use-toast", () => ({
  toast: (...args: unknown[]) => toast(...args),
  useToast: () => ({ toast }),
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "host" } } }),
}));
jest.mock("@stream-io/video-react-sdk", () => ({
  useCall: () => call,
  useCallStateHooks: () => ({
    useCallCustomData: () => ({ appointmentType: "CONSULTATION" }),
  }),
}));

import RecordingControls, {
  RECORDING_ACK_TIMEOUT_MS,
} from "../../app/meetings/[id]/components/RecordingControls";
import { useMeetingRecording } from "../../app/meetings/[id]/hooks/useMeetingRecording";

const reply = (status: number, body: Record<string, unknown> = {}) =>
  Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  });

let fetchMock: jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(console, "error").mockImplementation(() => {});
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  handlers.clear();
  call.state.recording = false;
  call.get.mockClear();
});
afterEach(() => jest.useRealTimers());

describe("useMeetingRecording", () => {
  it("keeps the flag it already knew through a 5xx and a network error, then recovers", async () => {
    fetchMock
      .mockImplementationOnce(() =>
        reply(200, { meetingId: "m1", recordingEnabled: true }),
      )
      .mockImplementationOnce(() => reply(503))
      .mockImplementationOnce(() => Promise.reject(new TypeError("offline")))
      .mockImplementation(() =>
        reply(200, { meetingId: "m1", recordingEnabled: true }),
      );

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useMeetingRecording(id),
      { initialProps: { id: "call-1" } },
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(result.current.recordingEnabled).toBe(true);

    // A re-read (the call id rotates on rejoin) that then fails transiently.
    fetchMock.mockReset();
    fetchMock
      .mockImplementationOnce(() => reply(503))
      .mockImplementationOnce(() => Promise.reject(new TypeError("offline")))
      .mockImplementation(() =>
        reply(200, { meetingId: "m1", recordingEnabled: true }),
      );
    rerender({ id: "call-1-r2" });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(result.current.recordingEnabled).toBe(true);
    expect(result.current.meetingId).toBe("m1");
    expect(result.current.error).not.toBeNull();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.error).toBeNull();
  });

  it("retries a first-load 5xx until it learns the flag", async () => {
    fetchMock
      .mockImplementationOnce(() => reply(500))
      .mockImplementation(() =>
        reply(200, { meetingId: "m1", recordingEnabled: true }),
      );

    const { result } = renderHook(() => useMeetingRecording("call-1"));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(result.current.recordingEnabled).toBe(false);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_100);
    });
    expect(result.current.recordingEnabled).toBe(true);
  });

  it("treats a 404 as a verdict and does not retry it", async () => {
    fetchMock.mockImplementation(() => reply(404, { error: "none" }));

    const { result } = renderHook(() => useMeetingRecording("call-1"));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });

    expect(result.current.recordingEnabled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("RecordingControls loading fallback", () => {
  it("re-reads the call and releases the button when no recording event arrives", async () => {
    fetchMock.mockImplementation(() => reply(200));
    render(
      <RecordingControls
        meetingId="m1"
        recordingEnabled
        showOnlyButton
        isHost
      />,
    );
    const button = screen.getByTitle("Start Recording") as HTMLButtonElement;

    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.disabled).toBe(true);

    call.state.recording = true;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RECORDING_ACK_TIMEOUT_MS + 100);
    });

    expect(call.get).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByTitle("Stop Recording") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
