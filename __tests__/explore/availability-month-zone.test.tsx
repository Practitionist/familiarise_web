/**
 * The expert page's grid reads are drawn in the display zone: the month
 * marks fetch that month's first to last day in that zone (not the device's
 * local midnight), and a failed read carries fixed copy, never the server's
 * own error text. Atoms the server marks too soon or over a plan limit are
 * not "still offered".
 */
import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { isSlotStillOffered } from "@/app/explore/experts/[consultantId]/hooks/useAvailabilityWindow";
import {
  AVAILABILITY_READ_FAILED_MESSAGE,
  monthBounds,
  useAvailabilityMonth,
  useAvailabilityWindow,
} from "@/lib/scheduling/use-availability-window";

const fetchMock = jest.fn();

function answer(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    headers: { get: () => null },
  };
}

function wrapper({ children }: Readonly<{ children: React.ReactNode }>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeAll(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

beforeEach(() => {
  fetchMock.mockReset();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("month marks in the display zone", () => {
  it("bounds October in Kolkata from its own first to last instant", () => {
    const { start, end } = monthBounds(
      new Date(2026, 9, 1, 12),
      "Asia/Kolkata",
    );
    expect(start.toISOString()).toBe("2026-09-30T18:30:00.000Z");
    expect(end.toISOString()).toBe("2026-10-31T18:30:00.000Z");
  });

  it("asks the grid for the zone's month, not the device's local midnight", async () => {
    fetchMock.mockResolvedValue(answer(200, { data: {} }));
    renderHook(
      () =>
        useAvailabilityMonth({
          consultantId: "cp-1",
          monthStart: new Date(2026, 9, 1),
          timezone: "Asia/Kolkata",
        }),
      { wrapper },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("startDateInUtc=2026-09-30T18:30:00.000Z");
    // Twelve hours past the month, for a session that crosses its last midnight.
    expect(url).toContain("endDateInUtc=2026-11-01T06:30:00.000Z");
  });
});

describe("a move read through the month picker", () => {
  it("names its purpose, so the booking horizon does not bind it", async () => {
    fetchMock.mockResolvedValue(answer(200, { data: {} }));
    renderHook(
      () =>
        useAvailabilityMonth({
          consultantId: "cp-1",
          monthStart: new Date(2026, 9, 1),
          timezone: "UTC",
          lead: { purpose: "reschedule" },
        }),
      { wrapper },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).toContain("purpose=reschedule");
  });
});

describe("a failed grid read", () => {
  it("carries fixed copy, never the server's error text", async () => {
    fetchMock.mockResolvedValue(
      answer(500, {
        error: "PrismaClientKnownRequestError: P2024 pool timeout",
      }),
    );
    const { result } = renderHook(
      () =>
        useAvailabilityWindow({
          consultantId: "cp-1",
          startUtc: new Date("2026-11-02T00:00:00.000Z"),
          endUtc: new Date("2026-11-09T00:00:00.000Z"),
          timezone: "UTC",
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.error).not.toBeNull(), {
      timeout: 5000,
    });
    expect(result.current.error?.message).toBe(
      AVAILABILITY_READ_FAILED_MESSAGE,
    );
    expect(result.current.error?.message).not.toMatch(/Prisma/);
  });
});

describe("isSlotStillOffered", () => {
  it("treats a too-soon or limit-reached atom as not offered", async () => {
    const start = new Date("2026-11-02T10:00:00.000Z");
    const end = new Date("2026-11-02T10:30:00.000Z");
    for (const flag of ["tooSoon", "limitReached"] as const) {
      fetchMock.mockResolvedValueOnce(
        answer(200, {
          data: {
            "2026-11-02": [
              {
                startsAt: start.toISOString(),
                isAllocated: false,
                bookingStatus: "available",
                [flag]: true,
              },
            ],
          },
        }),
      );
      await expect(isSlotStillOffered("cp-1", start, end)).resolves.toBe(false);
    }
  });
});
