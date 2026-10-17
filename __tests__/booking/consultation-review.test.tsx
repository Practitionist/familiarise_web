jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "buyer", role: "consultee" } } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("../../hooks/useCurrency", () => ({
  useCurrency: () => ({ formatPrice: (price: number) => `₹${price / 100}` }),
}));
jest.mock("../../components/booking/NotifyWhenFreeButton", () => ({
  HELD_BY_SOMEONE_ELSE: new Set(),
  NotifyWhenFreeButton: () => null,
}));
jest.mock("../../utils/scheduling-engine/intervals", () => ({
  breakDownSlotsPreservingStatus: (slots: unknown[]) => slots,
}));

import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import ConsultationPricingToggle from "@/app/explore/experts/[consultantId]/components/ConsultationPricingToggle";
import type { TIntervalTiming } from "@/types/slots";
import type { BookingMode } from "@prisma/client";

const firstSlot: TIntervalTiming = {
  slotId: "slot-1",
  dateInISO: "2026-10-05",
  dayOfWeek: "MONDAY",
  startsAt: "2026-10-05T10:00:00Z",
  endsAt: "2026-10-05T11:00:00Z",
  availabilityWindowId: "window-1",
  appointmentOccurrenceId: "",
  localStartTime: "10:00 AM",
  localEndTime: "11:00 AM",
  type: "CUSTOM",
  isAllocated: false,
  bookingStatus: "available",
};
const options = [
  {
    id: "plan-a",
    title: "1 Hour (1)",
    description: "Career conversation",
    price: 10000,
    priceCurrency: "INR",
    duration: "1 hour",
    durationInHours: 1,
  },
  {
    id: "plan-b",
    title: "1 Hour (2)",
    description: "Portfolio review",
    price: 15000,
    priceCurrency: "INR",
    duration: "1 hour",
    durationInHours: 1,
  },
];
const checkout = jest.fn();
function Harness({
  slots = [firstSlot],
  mode = "INSTANT",
  paused = false,
  loading = false,
  calendarLoading = false,
  calendarError = false,
}: {
  slots?: TIntervalTiming[];
  mode?: BookingMode;
  paused?: boolean;
  loading?: boolean;
  calendarLoading?: boolean;
  calendarError?: boolean;
}) {
  const [selectedDate, setSelectedDate] = useState<Date | null>(
    new Date("2026-10-05T00:00:00Z"),
  );
  const [currentDate, setCurrentDate] = useState(
    new Date("2026-10-01T00:00:00Z"),
  );
  const [selectedSlot, setSelectedSlot] = useState<TIntervalTiming | null>(
    null,
  );
  const [selectedPlanId, onPlanChange] = useState(options[0].id);
  return (
    <ConsultationPricingToggle
      consultationOptions={options}
      selectedPlanId={selectedPlanId}
      onPlanChange={onPlanChange}
      consultantDetails={{
        id: "expert",
        bookingMode: mode,
        acceptingRequests: !paused,
        consultationPlans: options.map((o) => ({
          id: o.id,
          durationInHours: 1,
        })),
      }}
      handleConsultationBooking={checkout}
      selectedDate={selectedDate}
      setSelectedDate={setSelectedDate}
      currentDate={currentDate}
      setCurrentDate={setCurrentDate}
      renderCalendar={() => [
        <button
          key="day"
          onClick={() => setSelectedDate(new Date("2026-10-05T00:00:00Z"))}
        >
          October 5
        </button>,
      ]}
      slotTimings={slots}
      selectedSlot={selectedSlot}
      setSelectedSlot={setSelectedSlot}
      timezone="UTC"
      slotsLoading={loading}
      calendarLoading={calendarLoading}
      calendarError={calendarError}
    />
  );
}
let root: Root;
let container: HTMLDivElement;
const button = (label: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) =>
      b.textContent?.trim() === label ||
      (label.includes("AM -") && b.textContent?.trim().startsWith(label)),
  )!;
async function click(label: string) {
  await act(async () => button(label).click());
}
async function review() {
  await click("Choose a time");
  await click("10:00 AM - 11:00 AM");
  await click("Review booking");
}

beforeEach(() => {
  jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-30T00:00:00Z"));
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  checkout.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.restoreAllMocks();
});

it("requires a time, preserves it on Back, and checks out the selected duplicate-duration plan", async () => {
  await act(async () => root.render(<Harness />));
  await click("Choose a time");
  expect(button("Review booking").disabled).toBe(true);
  await click("10:00 AM - 11:00 AM");
  await click("Review booking");
  await click("Back");
  expect(button("10:00 AM - 11:00 AM").getAttribute("aria-pressed")).toBe(
    "true",
  );
  await click("Review booking");
  await click("Continue to Checkout");
  expect(checkout).toHaveBeenCalledWith("plan-a");
  await click("Back");
  await click("Back");
  await click("Cancel");
  await act(async () => {
    const radio = document.querySelector<HTMLButtonElement>(
      '[role="radio"][data-state="unchecked"]',
    )!;
    radio.click();
  });
  await review();
  await click("Continue to Checkout");
  expect(checkout).toHaveBeenLastCalledWith("plan-b");
});

it("invalidates a window removed by an availability refresh", async () => {
  await act(async () => root.render(<Harness />));
  await review();
  await act(async () => root.render(<Harness slots={[]} />));
  expect(document.body.textContent).toContain("Availability changed");
  expect(button("Review booking").disabled).toBe(true);
  expect(checkout).not.toHaveBeenCalled();
});

it("prevents checkout while refresh is pending and switches to approval for an allocated window", async () => {
  await act(async () => root.render(<Harness />));
  await review();
  await act(async () => root.render(<Harness loading />));
  expect(button("Continue to Checkout").disabled).toBe(true);
  await act(async () =>
    root.render(<Harness slots={[{ ...firstSlot, isAllocated: true }]} />),
  );
  expect(button("Request for Approval")).toBeDefined();
  expect(checkout).not.toHaveBeenCalled();
});

it("keeps a paused request-only expert's final action disabled", async () => {
  await act(async () => root.render(<Harness mode="REQUEST" paused />));
  await review();
  expect(button("Request this time").disabled).toBe(true);
  expect(checkout).not.toHaveBeenCalled();
});

it("hides date buttons and availability claims until the month is loaded", async () => {
  await act(async () => root.render(<Harness calendarLoading />));
  await click("Choose a time");
  expect(
    document.querySelector('[data-testid="calendar-loading-grid"]'),
  ).not.toBeNull();
  expect(document.body.textContent).toContain("Checking available dates…");
  expect(
    document.querySelector(".calendar-surface")?.textContent,
  ).not.toContain("October 5");
  expect(document.body.textContent).not.toContain(
    "Outlined days have available times",
  );
  expect(button("Choose time").disabled).toBe(true);
  expect(
    document.querySelector(".calendar-surface")?.getAttribute("aria-busy"),
  ).toBe("true");

  await act(async () => root.render(<Harness />));
  expect(
    document.querySelector('[data-testid="calendar-loading-grid"]'),
  ).toBeNull();
  expect(button("October 5")).toBeDefined();
  expect(button("Choose time").disabled).toBe(false);
  expect(
    document.querySelector(".calendar-surface")?.getAttribute("aria-busy"),
  ).toBe("false");
});

it("keeps loaded dates visible while only times are refreshing", async () => {
  await act(async () => root.render(<Harness loading />));
  await click("Choose a time");
  expect(button("October 5")).toBeDefined();
  expect(
    document.querySelector('[data-testid="calendar-loading-grid"]'),
  ).toBeNull();
  expect(document.body.textContent).toContain("Checking available times…");
  expect(button("Choose time").disabled).toBe(true);
});

it("distinguishes a failed month read from loading and allows per-day fallback", async () => {
  await act(async () => root.render(<Harness calendarError />));
  await click("Choose a time");
  expect(document.body.textContent).toContain("Couldn’t check available dates");
  expect(document.body.textContent).not.toContain(
    "Outlined days have available times",
  );
  expect(
    document.querySelector('[data-testid="calendar-loading-grid"]'),
  ).toBeNull();
  expect(button("October 5").disabled).toBe(false);
  expect(checkout).not.toHaveBeenCalled();
});
