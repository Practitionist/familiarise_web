/**
 * The public booking dialog never acts on a stale pick: a poll that takes the
 * selected time disables the CTA at once, paints it "Just taken" for one
 * render, then clears it with a toast; and a time crossing the 15-minute lead
 * leaves the list on the clock alone, with no new data.
 */
import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

const mockToast = jest.fn();
jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));
jest.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "buyer-1", role: "consultee" } } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({
    formatPrice: (value: number) => `₹${value}`,
    formatPriceExact: (value: number) => `₹${value}`,
  }),
}));
jest.mock("@/components/booking/NotifyWhenFreeButton", () => ({
  HELD_BY_SOMEONE_ELSE: new Set<string>(),
  NotifyWhenFreeButton: () => null,
}));
jest.mock("@/utils/purchase-intent", () => ({
  consumePurchaseIntent: () => null,
  stashPurchaseIntent: jest.fn(),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import ConsultationPricingToggle, {
  TIME_JUST_TAKEN_MESSAGE,
} from "@/app/explore/experts/[consultantId]/components/ConsultationPricingToggle";
import type { TIntervalTiming } from "@/types/slots";

const DAY = new Date(2026, 10, 2, 12);

function atom(
  iso: string,
  extra: Partial<TIntervalTiming> = {},
): TIntervalTiming {
  const start = new Date(iso);
  return {
    slotId: `atom-${iso}`,
    dateInISO: iso,
    dayOfWeek: "MONDAY",
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
    availabilityWindowId: "aw-1",
    appointmentOccurrenceId: "",
    localStartTime: "",
    localEndTime: "",
    type: "WEEKLY",
    isAllocated: false,
    bookingStatus: "available",
    ...extra,
  };
}

const zone = {
  zone: "UTC",
  usingDeviceZone: false,
  canSwitch: false,
  toggle: () => undefined,
};

function Harness({
  slots,
  onSelectionChange,
}: Readonly<{
  slots: TIntervalTiming[];
  onSelectionChange?: (slot: TIntervalTiming | null) => void;
}>) {
  const [selected, setSelected] = React.useState<TIntervalTiming | null>(null);
  return (
    <ConsultationPricingToggle
      consultationOptions={[
        {
          id: "plan-30",
          title: "30 min",
          description: "",
          price: 500,
          priceCurrency: "INR",
          duration: "30 minutes",
          durationInHours: 0.5,
        },
      ]}
      consultantDetails={{
        id: "cp-1",
        bookingMode: "INSTANT",
        acceptingRequests: true,
        consultationPlans: [{ id: "plan-30", durationInHours: 0.5 }],
      }}
      handleConsultationBooking={jest.fn()}
      selectedDate={DAY}
      setSelectedDate={jest.fn()}
      currentDate={DAY}
      setCurrentDate={jest.fn()}
      renderCalendar={() => []}
      slotTimings={slots}
      slotsReady
      selectedSlot={selected}
      setSelectedSlot={(slot) => {
        onSelectionChange?.(slot);
        setSelected(slot);
      }}
      displayZone={zone}
    />
  );
}

function timeButton(hhmm: RegExp) {
  return screen.getByRole("button", { name: hhmm });
}

function cta() {
  return screen.getByRole("button", { name: "Continue to Checkout" });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-11-02T09:00:00.000Z"));
  mockToast.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("the public dialog's selection", () => {
  it("disables the CTA, paints Just taken once, then clears the pick with a toast", () => {
    const free = [
      atom("2026-11-02T10:00:00.000Z"),
      atom("2026-11-02T11:00:00.000Z"),
    ];
    const selections: (TIntervalTiming | null)[] = [];
    const { rerender } = render(
      <Harness slots={free} onSelectionChange={(s) => selections.push(s)} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Book Now" }));
    fireEvent.click(timeButton(/10:00/));
    expect(cta()).toBeEnabled();

    // The poll lands: 10:00 is now someone else's.
    const observer = new MutationObserver(() => undefined);
    observer.observe(document.body, { subtree: true, childList: true });
    act(() => {
      rerender(
        <Harness
          slots={[
            atom("2026-11-02T10:00:00.000Z", {
              bookingStatus: "fully-booked",
              isAllocated: true,
            }),
            free[1],
          ]}
          onSelectionChange={(s) => selections.push(s)}
        />,
      );
    });
    const painted = observer
      .takeRecords()
      .flatMap((record) => [...record.addedNodes])
      .some(
        (node) =>
          node instanceof HTMLElement &&
          (node.matches("[data-just-taken]") ||
            node.querySelector("[data-just-taken]") !== null),
      );
    observer.disconnect();

    expect(painted).toBe(true);
    expect(document.querySelector("[data-just-taken]")).toBeNull();
    expect(selections.at(-1)).toBeNull();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: TIME_JUST_TAKEN_MESSAGE }),
    );
    expect(cta()).toBeDisabled();
    expect(screen.queryByRole("button", { name: /10:00/ })).toBeNull();
  });

  it("drops a time that crosses the 15-minute lead on the clock alone", () => {
    jest.setSystemTime(new Date("2026-11-02T09:40:00.000Z"));
    render(<Harness slots={[atom("2026-11-02T10:00:00.000Z")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Book Now" }));
    expect(timeButton(/10:00/)).toBeInTheDocument();

    // 9:56 — inside the lead. Same data object, only the clock moved.
    act(() => {
      jest.advanceTimersByTime(16 * 60_000);
    });
    expect(screen.queryByRole("button", { name: /10:00/ })).toBeNull();
  });

  it("never lists a time the server marks too soon", () => {
    render(
      <Harness
        slots={[
          atom("2026-11-02T10:00:00.000Z", { tooSoon: true }),
          atom("2026-11-02T12:00:00.000Z"),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Book Now" }));
    expect(screen.queryByRole("button", { name: /10:00/ })).toBeNull();
    expect(timeButton(/12:00/)).toBeInTheDocument();
  });

  it("names half-hour times without the word slot", () => {
    render(<Harness slots={[atom("2026-11-02T10:00:00.000Z")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Book Now" }));
    expect(screen.getByText("Available half-hour times")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bslots?\b/i);
    expect(document.body.textContent).not.toMatch(/prefers/);
  });
});
