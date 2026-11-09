/**
 * The trial picker: an older date's answer that lands after a newer one can
 * never overwrite it; times paint from the shared token table with the buyer
 * legend; the 15-minute lead and the server's `tooSoon` make a time
 * unpickable; a failed read shows plain copy with a retry. The read carries
 * the consultee and the purpose, so the consultee's busy times and the
 * purpose's lead time (24 h for a reschedule) both apply.
 */
import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

const mockToast = jest.fn();
jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));
jest.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: { user: { id: "expert-1", timezone: "UTC" } },
    isPending: false,
  }),
}));

import { TrialScheduleCalendar } from "@/components/dashboard/shared/requests/components/TrialScheduleCalendar";

const fetchMock = jest.fn();

function answer(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

function atom(iso: string, extra: Record<string, unknown> = {}) {
  const start = new Date(iso);
  return {
    slotId: `atom-${iso}`,
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
    availabilityWindowId: "aw-1",
    type: "WEEKLY",
    isAllocated: false,
    bookingStatus: "available",
    ...extra,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function renderPicker() {
  return render(
    <TrialScheduleCalendar
      consultantId="cp-1"
      trialDurationMinutes={30}
      onSlotSelect={jest.fn()}
      onCancel={jest.fn()}
    />,
  );
}

beforeAll(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

beforeEach(() => {
  fetchMock.mockReset();
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-11-02T09:00:00.000Z"));
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("TrialScheduleCalendar", () => {
  it("keeps the newer date's times when an older date answers last", async () => {
    const today = deferred<unknown>();
    const fifth = deferred<unknown>();
    const sixth = deferred<unknown>();
    fetchMock
      .mockReturnValueOnce(today.promise)
      .mockReturnValueOnce(fifth.promise)
      .mockReturnValueOnce(sixth.promise);
    renderPicker();
    await act(async () => undefined);

    fireEvent.click(
      screen.getByRole("button", { name: /^(November 5|5 November)$/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /^(November 6|6 November)$/ }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toContain(
      "startDateInUtc=2026-11-06T00:00:00.000Z",
    );

    await act(async () => {
      sixth.resolve(
        answer(200, {
          data: { "2026-11-06": [atom("2026-11-06T14:00:00.000Z")] },
        }),
      );
    });
    await act(async () => {
      fifth.resolve(
        answer(200, {
          data: { "2026-11-05": [atom("2026-11-05T08:00:00.000Z")] },
        }),
      );
      today.resolve(answer(200, { data: {} }));
    });

    expect(
      screen.getByRole("button", { name: /2:00 PM|14:00/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /8:00 AM|08:00/i })).toBeNull();
  });

  it("paints from the token table, legends with the buyer keys, and applies the lead", async () => {
    fetchMock.mockResolvedValue(
      answer(200, {
        data: {
          "2026-11-02": [
            atom("2026-11-02T09:10:00.000Z"),
            atom("2026-11-02T10:00:00.000Z", { tooSoon: true }),
            atom("2026-11-02T11:00:00.000Z", {
              bookingStatus: "partially-booked",
              isAllocated: true,
            }),
            atom("2026-11-02T12:00:00.000Z", {
              bookingStatus: "fully-booked",
              isAllocated: true,
            }),
            atom("2026-11-02T13:00:00.000Z"),
          ],
        },
      }),
    );
    renderPicker();
    await act(async () => undefined);

    const statuses = Array.from(
      document.querySelectorAll<HTMLButtonElement>("[data-status]"),
    ).map((button) => [button.dataset.status, button.disabled]);
    expect(statuses).toEqual([
      ["tooSoon", true],
      ["tooSoon", true],
      ["partiallyBooked", true],
      ["fullyBooked", true],
      ["available", false],
    ]);
    for (const key of [
      "available",
      "partiallyBooked",
      "fullyBooked",
      "tooSoon",
    ]) {
      expect(
        document.querySelector(`[data-legend-swatch="${key}"]`),
      ).not.toBeNull();
    }
    expect(document.body.innerHTML).not.toMatch(/bg-(green|red|yellow)-/);
    expect(document.body.textContent).not.toMatch(/\bslots?\b/i);
  });

  it("shows plain copy and a retry when the read fails", async () => {
    fetchMock.mockResolvedValueOnce(
      answer(500, { error: "TypeError: cannot read properties of undefined" }),
    );
    renderPicker();
    await act(async () => undefined);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "We couldn't load the times for this day.",
    );
    expect(document.body.textContent).not.toMatch(/TypeError/);
    expect(mockToast).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(
      answer(200, {
        data: { "2026-11-02": [atom("2026-11-02T13:00:00.000Z")] },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await act(async () => undefined);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector('[data-status="available"]')).not.toBeNull();
  });

  it("asks the grid about the consultee and the purpose, and honours a reschedule's 24 h lead", async () => {
    fetchMock.mockResolvedValue(
      answer(200, {
        data: {
          "2026-11-02": [
            atom("2026-11-02T13:00:00.000Z"),
            atom("2026-11-02T15:00:00.000Z"),
          ],
        },
      }),
    );
    render(
      <TrialScheduleCalendar
        consultantId="cp-1"
        trialDurationMinutes={30}
        onSlotSelect={jest.fn()}
        onCancel={jest.fn()}
        consulteeUserId="user-learner"
        purpose="reschedule"
      />,
    );
    await act(async () => undefined);

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("consulteeUserId=user-learner");
    expect(url).toContain("purpose=reschedule");
    // Both times are under 24 hours away, so neither is offered.
    const statuses = Array.from(
      document.querySelectorAll<HTMLButtonElement>("[data-status]"),
    ).map((button) => button.dataset.status);
    expect(statuses).toEqual(["tooSoon", "tooSoon"]);
  });
});
