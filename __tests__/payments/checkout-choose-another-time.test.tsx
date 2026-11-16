/**
 * @jest-environment jsdom
 *
 * A consultation checkout whose chosen time can never be bought as picked sends
 * the buyer back to the same plan's grid: a taken, too-soon or off-grid refusal
 * arriving through the real Razorpay button, and a time that has already gone
 * when the page loads. Lock contention and payment failures stay on the page.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { Suspense } from "react";

jest.mock("react", () => ({
  ...jest.requireActual("react"),
  use: (promise: { __value: unknown }) => promise.__value,
}));
jest.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: null }) }));
jest.mock("@/hooks/useMaintenanceGuard", () => ({
  useMaintenanceGuard: () => ({ isBlocked: false, blockReason: null }),
}));
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));
const mockToast = jest.fn();
jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("@/app/checkout/components/OrgPayerSelector", () => ({
  OrgPayerSelector: () => null,
}));
jest.mock(
  "@/app/explore/experts/[consultantId]/hooks/useAvailabilityWindow",
  () => ({ isSlotStillOffered: async () => true }),
);

import ConsultationCheckoutPage from "@/app/checkout/plans/consultation/[planId]/page";
import { ErrorTypes } from "@/lib/errors/classification/payment-error-classification";
import { SLOT_JUST_TAKEN_MESSAGE } from "@/lib/errors/mapping/payment-error-toast-map";

const GRID = "/explore/experts/cp1?conflict=1&plan=plan1";

const future = (minutes: number) =>
  new Date(
    Math.ceil((Date.now() + minutes * 60_000) / 1_800_000) * 1_800_000,
  ).toISOString();

const plan = {
  id: "plan1",
  title: "Career strategy",
  price: 99950,
  consultantProfile: {
    id: "cp1",
    headline: "Career coach",
    domain: null,
    user: { id: "u1", name: "Asha Rao", image: "", workExperiences: [] },
  },
  language: "English",
  level: "ALL_LEVELS",
  durationInHours: 1,
};

/** What POST /api/checkout answers in this test. */
let checkoutAnswer: { status: number; body: Record<string, unknown> };

function jsonResponse(status: number, body: unknown) {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    clone: () => response,
  };
  return response;
}

beforeEach(() => {
  mockPush.mockReset();
  mockToast.mockReset();
  globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/checkout") {
      return jsonResponse(checkoutAnswer.status, checkoutAnswer.body);
    }
    if (url === "/api/checkout/context") {
      return jsonResponse(200, {
        buyerCountry: "IN",
        isInternational: false,
        exportZeroRated: false,
        gstRegistered: true,
        billingStateCode: "06",
        referralCreditsPaise: 0,
      });
    }
    if (url === "/api/referrals/credits/available") {
      return jsonResponse(200, { data: { totalAvailable: 0 } });
    }
    if (url.startsWith("/api/checkout/referral-pricing")) {
      return jsonResponse(200, { welcomeDiscount: null, creditCapBps: 0 });
    }
    if (url === "/api/plans/consultations/plan1") {
      return jsonResponse(200, { data: plan });
    }
    return jsonResponse(404, {});
  }) as unknown as typeof fetch;
});

const resolved = <T,>(value: T) =>
  Object.assign(Promise.resolve(value), { __value: value });

function renderCheckout(startsAt: string): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const page: ReactElement = (
    <ConsultationCheckoutPage
      params={resolved({ planId: "plan1" })}
      searchParams={resolved({
        startsAt,
        endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
        availabilityWindowWeeklyId: "aw1",
      })}
    />
  );
  render(
    <QueryClientProvider client={client}>
      <Suspense fallback={null}>{page}</Suspense>
    </QueryClientProvider>,
  );
}

async function pressPay(): Promise<void> {
  const pay = await screen.findByRole(
    "button",
    { name: "Pay with Razorpay" },
    { timeout: 4000 },
  );
  fireEvent.click(pay);
  await waitFor(() =>
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/checkout",
      expect.anything(),
    ),
  );
}

describe("a refused time sends the buyer back to the plan's grid", () => {
  it.each([
    {
      name: "taken",
      status: 409,
      body: {
        error:
          "Someone else booked this time moments ago. Your card was not charged.",
        errorType: ErrorTypes.AVAILABILITY,
        code: ErrorTypes.SLOT_TAKEN,
        yourCardWasNotCharged: true,
      },
      title: SLOT_JUST_TAKEN_MESSAGE,
    },
    {
      name: "too soon",
      status: 400,
      body: {
        error:
          "This time slot starts too soon (in 9 minutes). Bookings must be made at least 15 minutes in advance.",
        errorType: ErrorTypes.AVAILABILITY,
        code: ErrorTypes.SLOT_TOO_SOON,
        field: "startsAt",
      },
      title: "That Time Is Now Too Close",
    },
    {
      name: "off the grid",
      status: 400,
      body: {
        error: "Times start on the hour or half hour",
        errorType: ErrorTypes.AVAILABILITY,
        code: ErrorTypes.SLOT_NOT_ON_GRID,
        field: "startsAt",
      },
      title: "That Time Isn't Bookable",
    },
  ])("$name", async ({ status, body, title }) => {
    checkoutAnswer = { status, body };
    renderCheckout(future(48 * 60));
    await pressPay();

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(GRID));
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title,
        description: body.error,
        variant: "destructive",
      }),
    );
  });
});

describe("a refusal the same time can survive stays on the page", () => {
  it.each([
    {
      name: "the booking lock is unavailable",
      status: 503,
      body: {
        error: "Booking is busy right now. Please try again in a moment.",
        errorType: ErrorTypes.BOOKING_LOCK_UNAVAILABLE,
      },
    },
    {
      name: "a conflict with no retry advice",
      status: 409,
      body: {
        error: "Someone is one step ahead of you.",
        errorType: ErrorTypes.SERIALIZATION_CONFLICT,
      },
    },
    {
      name: "the payment could not be created",
      status: 500,
      body: {
        error: "Payments aren't working right now. Please try again shortly.",
        errorType: ErrorTypes.PAYMENT_PROCESSING,
      },
    },
  ])("$name", async ({ status, body }) => {
    checkoutAnswer = { status, body };
    renderCheckout(future(48 * 60));
    await pressPay();

    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    expect(mockPush).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Pay with Razorpay" }),
    ).toBeTruthy();
  });
});

describe("a time that is gone when the page loads", () => {
  it("offers one action back to the plan's grid instead of the pay form", async () => {
    renderCheckout(new Date(Date.now() + 5 * 60_000).toISOString());

    expect(
      await screen.findByText(
        "This time can't be booked",
        {},
        { timeout: 4000 },
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Choose another time" }),
    ).toHaveAttribute("href", GRID);
    expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Pay with Razorpay" }),
    ).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();
  });
});
