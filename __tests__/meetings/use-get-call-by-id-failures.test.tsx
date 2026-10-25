/**
 * The join hook classifies a failed join and re-runs it by itself only when the
 * provider is the cause; a typed refusal is a verdict, not a failure.
 */
import { act, renderHook } from "@testing-library/react";

import { MAX_PROVIDER_AUTO_RETRIES } from "../../app/meetings/[id]/join-failure";

const callInstance = {
  get: jest.fn(() => Promise.resolve()),
  join: jest.fn(() => Promise.resolve()),
};
const client = { call: jest.fn(() => callInstance) };

jest.mock("@stream-io/video-react-sdk", () => ({
  ...jest.requireActual("@stream-io/video-react-sdk"),
  useStreamVideoClient: () => client,
}));
jest.mock("../../lib/stream/media-teardown", () => ({
  leaveCallAndReleaseMedia: () => Promise.resolve(),
}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock("../../actions/stream/meetings/meeting.action", () => ({
  provisionAppointmentMeeting: jest.fn(),
}));

import { useGetCallById } from "../../app/meetings/[id]/hooks/useGetCallById";

const answer = (status: number, body: Record<string, unknown> = {}) => {
  const response = {
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    clone: () => response,
  };
  return Promise.resolve(response);
};

let fetchMock: jest.Mock;

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
});

describe("useGetCallById failure handling", () => {
  it("retries a provider outage by itself with backoff, then recovers", async () => {
    fetchMock
      .mockImplementationOnce(() => answer(503, { error: "down" }))
      .mockImplementationOnce(() =>
        answer(200, { callType: "default", callId: "c1", role: "host" }),
      );

    const { result } = renderHook(() => useGetCallById("c1"));
    await settle();

    expect(result.current.failure?.kind).toBe("provider_unavailable");
    expect(result.current.isCallLoading).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(2_100);
    });
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.failure).toBeNull();
    expect(result.current.call).not.toBeNull();
  });

  it("stops retrying on its own after the capped budget", async () => {
    fetchMock.mockImplementation(() => answer(503, { error: "down" }));

    const { result } = renderHook(() => useGetCallById("c1"));
    await settle();
    for (let i = 0; i < MAX_PROVIDER_AUTO_RETRIES + 2; i++) {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(31_000);
      });
    }

    expect(fetchMock).toHaveBeenCalledTimes(1 + MAX_PROVIDER_AUTO_RETRIES);
    expect(result.current.failure?.kind).toBe("provider_unavailable");

    // A person's retry restarts the budget.
    act(() => result.current.retryJoin());
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2 + MAX_PROVIDER_AUTO_RETRIES);
  });

  it("surfaces an unrecognised server fault as unknown and never retries it by itself", async () => {
    fetchMock.mockImplementation(() => answer(500, { error: "boom" }));

    const { result } = renderHook(() => useGetCallById("c1"));
    await settle();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(120_000);
    });

    expect(result.current.failure?.kind).toBe("unknown");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementationOnce(() =>
      answer(200, { callType: "default", callId: "c1", role: "host" }),
    );
    act(() => result.current.retryJoin());
    await settle();
    expect(result.current.failure).toBeNull();
  });

  it("treats a typed refusal as access, not as a failure", async () => {
    fetchMock.mockImplementation(() =>
      answer(403, { error: "Too early", code: "TOO_EARLY" }),
    );

    const { result } = renderHook(() => useGetCallById("c1"));
    await settle();

    expect(result.current.failure).toBeNull();
    expect(result.current.access?.code).toBe("TOO_EARLY");
  });

  it("classifies a thrown Stream get() on a full call", async () => {
    fetchMock.mockImplementation(() =>
      answer(200, { callType: "default", callId: "c1", role: "participant" }),
    );
    callInstance.get.mockRejectedValueOnce(
      new Error("call participant limit reached"),
    );

    const { result } = renderHook(() => useGetCallById("c1"));
    await settle();

    expect(result.current.failure?.kind).toBe("room_full");
  });
});
