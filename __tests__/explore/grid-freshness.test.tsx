// The expert page's grid stays fresh: a visible tab polls with the ETag and keeps its
// data on a 304, a hidden tab never polls, failures back off, a taken slot sends the
// buyer back to a refetched grid, and checkout re-asks the grid before Pay.

const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
jest.mock("../../hooks/use-toast", () => {
  const toast = jest.fn();
  return { useToast: () => ({ toast }) };
});

import React, { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { isSlotStillOffered } from "../../app/explore/experts/[consultantId]/hooks/useAvailabilityWindow";
import {
  availabilityQueryKey,
  useAvailabilityWindow,
} from "../../lib/scheduling/use-availability-window";
import { useChooseAnotherTime } from "../../app/explore/experts/[consultantId]/hooks/useChooseAnotherTime";
import { useToast } from "../../hooks/use-toast";
import {
  createGridPollInterval,
  GRID_POLL_BACKOFF_MS,
} from "../../lib/scheduling/availabilityPolling";
import { SLOT_JUST_TAKEN_MESSAGE } from "../../lib/errors/mapping/payment-error-toast-map";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const START = new Date("2026-11-02T00:00:00.000Z");
const END = new Date("2026-11-09T00:00:00.000Z");
const fetchMock = jest.fn();
let visibility: DocumentVisibilityState = "visible";
let root: Root | null = null;

function answer(status: number, body?: unknown, etag?: string) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    headers: {
      get: (name: string) => (name === "ETag" ? (etag ?? null) : null),
    },
  };
}

async function mount(element: React.ReactElement) {
  const host = document.createElement("div");
  root = createRoot(host);
  await act(async () => root?.render(element));
}

beforeAll(() => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock.mockReset();
  push.mockReset();
  visibility = "visible";
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  jest.useRealTimers();
});

describe("the consultee grid poll", () => {
  it("polls with the ETag while visible, keeps its data on a 304, and stops while hidden", async () => {
    const grid = { "2026-11-02": [{ startsAt: "2026-11-02T10:00:00.000Z" }] };
    fetchMock
      .mockResolvedValueOnce(answer(200, { data: grid }, '"v1"'))
      .mockResolvedValue(answer(304));
    const seen: unknown[] = [];
    function Probe() {
      const { data } = useAvailabilityWindow({
        consultantId: "cp-1",
        startUtc: START,
        endUtc: END,
        timezone: "UTC",
      });
      useEffect(() => {
        if (data) seen.push(data);
      }, [data]);
      return null;
    }
    const client = new QueryClient();
    await mount(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
    await act(async () => jest.advanceTimersByTimeAsync(0));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => jest.advanceTimersByTimeAsync(76_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({
      "X-Availability-If-None-Match": '"v1"',
    });
    const cached = client.getQueryData<{ data: unknown }>(
      availabilityQueryKey("cp-1", START, END, "UTC"),
    );
    expect(cached).toEqual({ data: grid, quota: null, leadMs: null });
    expect(seen.at(-1)).toBe(cached?.data);

    visibility = "hidden";
    await act(async () => jest.advanceTimersByTimeAsync(5 * 60_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("backs off to five minutes after three failed polls and resets on a success", () => {
    const interval = createGridPollInterval(() => 0);
    expect(interval({ dataUpdateCount: 1, errorUpdateCount: 0 })).toBe(60_000);
    expect(interval({ dataUpdateCount: 1, errorUpdateCount: 2 })).toBe(60_000);
    expect(interval({ dataUpdateCount: 1, errorUpdateCount: 3 })).toBe(
      GRID_POLL_BACKOFF_MS,
    );
    expect(interval({ dataUpdateCount: 2, errorUpdateCount: 3 })).toBe(60_000);
  });
});

describe("a slot that was just taken", () => {
  it("invalidates the grid, toasts, and returns the buyer to the plan's picker", async () => {
    const client = new QueryClient();
    const key = availabilityQueryKey("cp-1", START, END, "UTC");
    client.setQueryData(key, {});
    let onTaken: () => void = () => undefined;
    function Probe() {
      const choose = useChooseAnotherTime("cp-1", "plan-1");
      useEffect(() => {
        onTaken = () => choose({ title: SLOT_JUST_TAKEN_MESSAGE });
      }, [choose]);
      return null;
    }
    await mount(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
    await act(async () => onTaken());

    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    expect(useToast().toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: SLOT_JUST_TAKEN_MESSAGE }),
    );
    expect(push).toHaveBeenCalledWith(
      "/explore/experts/cp-1?conflict=1&plan=plan-1",
    );
  });

  it("the checkout mount check reports a taken atom, and fails open on a failed read", async () => {
    const at = (iso: string, isAllocated: boolean) => ({
      startsAt: iso,
      isAllocated,
      bookingStatus: isAllocated ? "fully-booked" : "available",
    });
    const start = new Date("2026-11-02T10:00:00.000Z");
    const end = new Date("2026-11-02T11:00:00.000Z");
    fetchMock.mockResolvedValueOnce(
      answer(200, {
        data: {
          "2026-11-02": [
            at("2026-11-02T10:00:00.000Z", false),
            at("2026-11-02T10:30:00.000Z", true),
          ],
        },
      }),
    );
    await expect(isSlotStillOffered("cp-1", start, end)).resolves.toBe(false);

    fetchMock.mockResolvedValueOnce(
      answer(200, {
        data: {
          "2026-11-02": [
            at("2026-11-02T10:00:00.000Z", false),
            at("2026-11-02T10:30:00.000Z", false),
          ],
        },
      }),
    );
    await expect(isSlotStillOffered("cp-1", start, end)).resolves.toBe(true);

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(isSlotStillOffered("cp-1", start, end)).resolves.toBe(true);
  });
});
