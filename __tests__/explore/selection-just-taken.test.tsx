/**
 * The public One-time dialog: a poll that takes the selected time clears the
 * pick and disables the button; "Book Now" on a second plan card books that
 * card's plan; a time the request door says is held reads taken.
 */
import * as React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

let mockMonth: Record<string, unknown[]> = {};
jest.mock("@/lib/scheduling/use-availability-window", () => ({
  ...jest.requireActual("@/lib/scheduling/use-availability-window"),
  useAvailabilityMonth: ({ timezone }: { timezone: string | null }) => ({
    data: timezone ? mockMonth : undefined,
    isPending: !timezone,
    isError: false,
    refetch: jest.fn(),
  }),
}));
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
jest.mock("@/components/pricing/BuyerPriceProvider", () => ({
  useBuyerPrice: () => ({
    gstRegistered: false,
    formatBuyerPrice: (value: number) => `₹${value}`,
    noteFor: () => null,
  }),
}));
jest.mock("@/components/booking/NotifyWhenFreeButton", () => ({
  HELD_BY_SOMEONE_ELSE: new Set(["SLOT_TAKEN", "LOCK_CONTENTION"]),
  NotifyWhenFreeButton: () => <span>Notify me if this time opens</span>,
}));
jest.mock("@/utils/purchase-intent", () => ({
  consumePurchaseIntent: () => null,
  stashPurchaseIntent: jest.fn(),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import ConsultationPricingToggle from "@/app/explore/experts/[consultantId]/components/ConsultationPricingToggle";
import type { BookingMode } from "@prisma/client";

const DAY = Date.parse("2026-11-04T00:00:00.000Z");
const HOUR = 3_600_000;

function atoms(booked: number[] = []) {
  return [10, 10.5, 11, 11.5].map((h) => ({
    startsAt: new Date(DAY + h * HOUR).toISOString(),
    endsAt: new Date(DAY + (h + 0.5) * HOUR).toISOString(),
    bookingStatus: booked.includes(h) ? "fully-booked" : "available",
  }));
}

const plan = (id: string, title: string) => ({
  id,
  title,
  description: "",
  price: 500,
  priceCurrency: "INR",
  duration: "30 minutes",
  durationInHours: 0.5,
});

function Dialog({ mode = "INSTANT" }: Readonly<{ mode?: BookingMode }>) {
  return (
    <ConsultationPricingToggle
      consultationOptions={[plan("plan-a", "A"), plan("plan-b", "B")]}
      consultantDetails={{
        id: "cp-1",
        bookingMode: mode,
        acceptingRequests: true,
        consultationPlans: [
          { id: "plan-a", durationInHours: 0.5 },
          { id: "plan-b", durationInHours: 0.5 },
        ],
      }}
      handleConsultationBooking={jest.fn()}
      displayZone={{
        zone: "UTC",
        usingDeviceZone: false,
        canSwitch: false,
        toggle: () => undefined,
      }}
    />
  );
}

const fetchMock = jest.fn();
beforeAll(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  globalThis.crypto.randomUUID ??= () => "00000000-0000-4000-8000-000000000000";
});
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-11-02T09:00:00.000Z"));
  mockMonth = { "2026-11-04": atoms() };
  mockToast.mockReset();
  fetchMock.mockReset();
});
afterEach(() => jest.useRealTimers());

const time = (name: RegExp) => screen.getByRole("button", { name });
const bookNow = (index: number) =>
  fireEvent.click(screen.getAllByRole("button", { name: "Book Now" })[index]);

it("clears a pick a poll shows taken and disables the button", () => {
  const { rerender } = render(<Dialog />);
  bookNow(0);
  fireEvent.click(time(/^10:00 am to 10:30 am, free/));
  const cta = screen.getByRole("button", { name: "Continue to Checkout" });
  expect(cta).toBeEnabled();
  mockMonth = { "2026-11-04": atoms([10]) };
  act(() => rerender(<Dialog />));
  expect(cta).toBeDisabled();
  expect(screen.queryByRole("button", { name: /^10:00 am/ })).toBeNull();
  expect(screen.getByText("1 time already taken")).toBeVisible();
});

it("books the second card's plan, and reads a held time as taken", async () => {
  fetchMock.mockResolvedValue({
    ok: false,
    status: 409,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? "application/json" : null,
    },
    json: async () => ({ error: "Taken", code: "SLOT_TAKEN" }),
    text: async () => JSON.stringify({ error: "Taken", code: "SLOT_TAKEN" }),
  });
  render(<Dialog mode="REQUEST" />);
  bookNow(1);
  expect(screen.getByRole("heading", { name: /Book B Consultation/ }));
  fireEvent.click(time(/^11:00 am to 11:30 am, free/));
  fireEvent.click(screen.getByRole("button", { name: "Request this time" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const [, init] = fetchMock.mock.calls[0];
  expect(JSON.parse(init.body).consultationPlanId).toBe("plan-b");
  await waitFor(() =>
    expect(time(/^11:00 am to 11:30 am, taken, someone else/)).toHaveAttribute(
      "aria-disabled",
      "true",
    ),
  );
  expect(screen.getByText("Notify me if this time opens")).toBeVisible();
});
