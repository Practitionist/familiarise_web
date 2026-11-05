/**
 * The allocate page's Regular-time card (mobile-first chips, a live hint, the
 * "N to fix" badge and the horizon rows) and the client's read-only line.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/components/ui/use-toast", () => ({ toast: jest.fn() }));
jest.mock("@/components/scheduling/MobileAutoSchedule", () => ({
  MobileAutoSchedule: () => (
    <button type="button">Auto-schedule this week</button>
  ),
}));

import { RegularTimeCard } from "@/components/scheduling/RegularTimeCard";
import { RegularTimeSummary } from "@/components/scheduling/RegularTimeSummary";
import { DesktopOnlyNotice } from "@/components/scheduling/DesktopOnlyNotice";

const view = {
  perWeek: 3,
  slots: [1, 3, 5].map((weekday) => ({ weekday, localStartMinutes: 1080 })),
  label: "Mon, Wed, Fri at 18:00",
  timeZone: "Asia/Kolkata",
  weekCount: 26,
  paused: false,
  weeks: [
    {
      weekIndex: 2,
      startsAt: "2026-11-15T18:30:00.000Z",
      endsAt: "2026-11-22T18:30:00.000Z",
      capacity: 3,
      held: 1,
      shortBy: 2,
      placed: [{ id: "o1", startsAt: "2099-11-16T12:30:00.000Z" }],
      conflicts: [
        { reason: "TAKEN", startsAt: "2026-11-18T12:30:00.000Z" },
        { reason: "OUTSIDE_HOURS", startsAt: "2026-11-20T12:30:00.000Z" },
      ],
    },
  ],
};

beforeEach(() => {
  globalThis.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => view,
  })) as unknown as typeof fetch;
});

describe("RegularTimeCard (T25)", () => {
  it("shows the saved days, the zone, the horizon row and '2 to fix'; Skip hides one", async () => {
    const onPickWeek = jest.fn();
    render(
      <RegularTimeCard
        subscriptionId="sub-1"
        onPickWeek={onPickWeek}
        onChanged={jest.fn()}
      />,
    );
    expect(await screen.findByText("2 to fix")).toBeTruthy();
    expect(screen.getByText(/Times shown in Asia\/Kolkata/)).toBeTruthy();
    expect(screen.getByText("Week 3 of 26")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Mon" }).getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(
      screen.getAllByRole("button", { name: "Pick another time" })[0],
    );
    expect(onPickWeek).toHaveBeenCalledWith(
      new Date("2026-11-15T18:30:00.000Z"),
    );
    fireEvent.click(screen.getAllByRole("button", { name: /Skip/ })[0]);
    expect(await screen.findByText("1 to fix")).toBeTruthy();
  });

  it("hints live and blocks Save when the count is wrong", async () => {
    render(
      <RegularTimeCard
        subscriptionId="sub-1"
        onPickWeek={jest.fn()}
        onChanged={jest.fn()}
      />,
    );
    await screen.findByText("2 to fix");
    fireEvent.click(screen.getByRole("button", { name: "Fri" }));
    expect(screen.getByRole("status").textContent).toContain(
      "Pick 3 times a week",
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Save regular time",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

describe("RegularTimeSummary (T25)", () => {
  it("reads the client's regular time and next session", async () => {
    render(<RegularTimeSummary appointmentId="appt-1" />);
    await waitFor(() =>
      expect(
        screen.getByText(
          "Your regular time: Mon, Wed, Fri at 18:00 (Asia/Kolkata)",
        ),
      ).toBeTruthy(),
    );
    expect(screen.getByText(/Next:/)).toBeTruthy();
  });
});

describe("DesktopOnlyNotice on a phone", () => {
  it("says only exact picking needs a computer when the phone can auto-schedule", () => {
    window.matchMedia = jest.fn(() => ({
      matches: false,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    })) as unknown as typeof window.matchMedia;
    const { rerender } = render(
      <DesktopOnlyNotice mobileAction={<button type="button">Auto</button>}>
        <div />
      </DesktopOnlyNotice>,
    );
    expect(
      screen.getByText("Picking exact times needs a computer"),
    ).toBeTruthy();
    rerender(
      <DesktopOnlyNotice>
        <div />
      </DesktopOnlyNotice>,
    );
    expect(
      screen.getByText("Please access this on desktop for now"),
    ).toBeTruthy();
  });
});
