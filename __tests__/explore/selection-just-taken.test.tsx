/**
 * The public One-time dialog: a poll that takes the selected time clears the
 * pick and disables the button; "Book Now" on a second plan card books that
 * card's plan; a time the request door says is held clears the pick, says so
 * inline and opens the taken list with "Notify me"; checkout's "choose another
 * time" link opens the refused plan's dialog with nothing picked, even over a
 * saved purchase intent.
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
let mockReadAt = 0;
jest.mock("@/lib/scheduling/use-availability-window", () => ({
  ...jest.requireActual("@/lib/scheduling/use-availability-window"),
  useAvailabilityMonth: ({ timezone }: { timezone: string | null }) => ({
    data: timezone ? mockMonth : undefined,
    dataUpdatedAt: mockReadAt,
    isPending: !timezone,
    isError: false,
    refetch: jest.fn(),
  }),
}));
const mockToast = jest.fn();
jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));
let mockSession: { user: { id: string; role: string } } | null = {
  user: { id: "buyer-1", role: "consultee" },
};
jest.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: mockSession }),
}));
let mockSearch = new URLSearchParams();
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => mockSearch,
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
  NotifyWhenFreeButton: ({ onSignIn }: { onSignIn?: () => void }) => (
    <button type="button" onClick={onSignIn}>
      Notify me
    </button>
  ),
}));
// One session-storage slot: a stash overwrites it, a consume reads and clears it.
let mockStoredIntent: unknown = null;
jest.mock("@/utils/purchase-intent", () => ({
  consumePurchaseIntent: () => {
    const intent = mockStoredIntent;
    mockStoredIntent = null;
    return intent;
  },
  stashPurchaseIntent: (intent: unknown) => {
    mockStoredIntent = intent;
  },
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { backupBookHref } from "@/lib/booking/interest/backup-interest-list";
import { chooseAnotherTimeHref } from "@/app/explore/experts/[consultantId]/hooks/useChooseAnotherTime";
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

const mockBook = jest.fn();

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
      handleConsultationBooking={mockBook}
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
  mockReadAt = 0;
  mockSearch = new URLSearchParams();
  mockSession = { user: { id: "buyer-1", role: "consultee" } };
  mockStoredIntent = null;
  mockPush.mockReset();
  window.history.replaceState(null, "", "/");
  mockBook.mockReset();
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
  expect(
    screen.getByRole("button", { name: "Hide taken times" }),
  ).toHaveAttribute("aria-expanded", "true");
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
  expect(
    screen.getByRole("heading", { name: /Book B Consultation/ }),
  ).toBeVisible();
  fireEvent.click(time(/^11:00 am to 11:30 am, free/));
  fireEvent.click(screen.getByRole("button", { name: "Request this time" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const [, init] = fetchMock.mock.calls[0];
  expect(JSON.parse(init.body).consultationPlanId).toBe("plan-b");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Hide taken times" }),
    ).toHaveAttribute("aria-expanded", "true"),
  );
  expect(screen.getByRole("status")).toHaveTextContent(/just taken/);
  expect(screen.getByRole("listitem")).toHaveTextContent(
    /^11:00 am to 11:30 am, taken, someone else/,
  );
  expect(screen.getByText("Notify me")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Request this time" }),
  ).toBeDisabled();
});

it("checkout's choose-another-time link opens that plan's dialog with nothing picked", () => {
  mockSearch = new URL(
    chooseAnotherTimeHref("cp-1", "plan-b"),
    "https://x.test",
  ).searchParams;
  render(<Dialog />);
  expect(
    screen.getByRole("heading", { name: /Book B Consultation/ }),
  ).toBeVisible();
  expect(time(/^11:00 am to 11:30 am, free/)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(
    screen.getByRole("button", { name: "Continue to Checkout" }),
  ).toBeDisabled();
});

const savedIntentForPlanA = () => ({
  consultantId: "cp-1",
  consultationPlanId: "plan-a",
  slot: {
    startsAt: new Date(DAY + 11 * HOUR).toISOString(),
    endsAt: new Date(DAY + 11.5 * HOUR).toISOString(),
  },
});

it.each([
  ["signed in on arrival", false],
  ["signed in after the link opened", true],
])(
  "the choose-another-time link outranks a saved purchase intent (%s)",
  (_label, sessionArrivesLate) => {
    mockStoredIntent = savedIntentForPlanA();
    mockSearch = new URL(
      chooseAnotherTimeHref("cp-1", "plan-b"),
      "https://x.test",
    ).searchParams;
    if (sessionArrivesLate) mockSession = null;
    const { rerender } = render(<Dialog />);
    if (sessionArrivesLate) {
      mockSession = { user: { id: "buyer-1", role: "consultee" } };
      act(() => rerender(<Dialog />));
    }
    expect(
      screen.getByRole("heading", { name: /Book B Consultation/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Continue to Checkout" }),
    ).toBeDisabled();
    expect(mockBook).not.toHaveBeenCalled();
  },
);

/** A signed-out buyer on the recovery link is sent to sign in, then lands on the callback. */
function returnFromSignIn(unmount: () => void, mode: BookingMode) {
  const signIn = new URL(
    String(mockPush.mock.calls.at(-1)?.[0]),
    "https://x.test",
  );
  const callback = new URL(
    signIn.searchParams.get("callbackUrl") ?? "",
    "https://x.test",
  );
  unmount();
  window.history.replaceState(null, "", callback.pathname + callback.search);
  mockSearch = callback.searchParams;
  mockSession = { user: { id: "buyer-1", role: "consultee" } };
  render(<Dialog mode={mode} />);
}

function openRecoveryLinkSignedOut() {
  mockStoredIntent = savedIntentForPlanA();
  const href = chooseAnotherTimeHref("cp-1", "plan-b");
  window.history.replaceState(null, "", href);
  mockSearch = new URL(href, "https://x.test").searchParams;
  mockSession = null;
}

it("a time requested from the recovery link survives the sign-in round trip", () => {
  openRecoveryLinkSignedOut();
  const { unmount } = render(<Dialog mode="REQUEST" />);
  fireEvent.click(time(/^10:00 am to 10:30 am, free/));
  fireEvent.click(screen.getByRole("button", { name: "Request this time" }));
  returnFromSignIn(unmount, "REQUEST");
  expect(
    screen.getByRole("heading", { name: /Book B Consultation/ }),
  ).toBeVisible();
  expect(time(/^10:00 am to 10:30 am, free/)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

it("a Notify me pressed on the recovery link survives the sign-in round trip", () => {
  mockMonth = { "2026-11-04": atoms([11]) };
  openRecoveryLinkSignedOut();
  const { unmount } = render(<Dialog />);
  fireEvent.click(screen.getByRole("button", { name: /taken time/ }));
  fireEvent.click(screen.getByRole("button", { name: "Notify me" }));
  returnFromSignIn(unmount, "INSTANT");
  expect(
    screen.getByRole("heading", { name: /Book B Consultation/ }),
  ).toBeVisible();
  expect(mockToast).toHaveBeenCalledWith(
    expect.objectContaining({
      description: "Press Notify me on the time you wanted.",
    }),
  );
  expect(
    screen.getByRole("button", { name: "Hide taken times" }),
  ).toHaveAttribute("aria-expanded", "true");
});

it("a link naming another expert's plan opens no dialog", () => {
  mockSearch = new URL(
    chooseAnotherTimeHref("cp-1", "someone-elses-plan"),
    "https://x.test",
  ).searchParams;
  render(<Dialog />);
  expect(
    screen.queryByRole("heading", { name: /Book . Consultation/ }),
  ).toBeNull();
});

it("a waitlist notice link opens its plan's dialog on that time, ready for checkout", () => {
  const href = backupBookHref({
    consultantProfileId: "cp-1",
    planKind: "CONSULTATION",
    planId: "plan-b",
    windowStart: new Date(DAY + 11 * HOUR).toISOString(),
    windowEnd: new Date(DAY + 11.5 * HOUR).toISOString(),
  });
  mockSearch = new URL(href, "https://x.test").searchParams;
  render(<Dialog />);
  expect(
    screen.getByRole("heading", { name: /Book B Consultation/ }),
  ).toBeVisible();
  expect(time(/^11:00 am to 11:30 am, free/)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Continue to Checkout" }));
  expect(mockBook).toHaveBeenCalledWith(
    "plan-b",
    expect.objectContaining({
      startsAt: new Date(DAY + 11 * HOUR).toISOString(),
      window: expect.objectContaining({ type: "WEEKLY" }),
    }),
  );
});
