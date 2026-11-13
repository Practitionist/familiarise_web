/**
 * @jest-environment jsdom
 *
 * One smoke render per plan type through the shared checkout shell: the plan
 * loads, the details and pricing card render, a non-whole-rupee total shows its
 * paise, and Razorpay is offered.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { Suspense } from "react";

// Next supplies React's `use` at runtime; the page props are plain resolved values here.
jest.mock("react", () => ({
  ...jest.requireActual("react"),
  use: (promise: { __value: unknown }) => promise.__value,
}));
jest.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: null }) }));
jest.mock("@/hooks/useMaintenanceGuard", () => ({
  useMaintenanceGuard: () => ({ isBlocked: false, blockReason: null }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/app/checkout/components/RazorpayCheckout", () => ({
  __esModule: true,
  default: ({ label = "Pay with Razorpay" }: { label?: string }) => (
    <button type="button">{label}</button>
  ),
}));
jest.mock("@/app/checkout/components/OrgPayerSelector", () => ({
  OrgPayerSelector: () => null,
}));
jest.mock(
  "@/app/explore/experts/[consultantId]/hooks/useAvailabilityWindow",
  () => ({
    isSlotStillOffered: async () => true,
  }),
);
jest.mock(
  "@/app/explore/experts/[consultantId]/hooks/useSlotJustTaken",
  () => ({
    useSlotJustTaken: () => jest.fn(),
  }),
);
jest.mock("@/lib/booking/batch-cards", () => ({
  deriveBatchCards: () => [
    {
      classId: "c1",
      label: "Batch 1",
      canEnrol: true,
      enrolment: {
        state: "open",
        basePaise: 99950,
        isLateJoin: false,
        remaining: 8,
        N: 8,
      },
    },
  ],
}));

import WebinarCheckoutPage from "@/app/checkout/plans/webinar/[planId]/page";
import ClassCheckoutPage from "@/app/checkout/plans/class/[planId]/page";
import ConsultationCheckoutPage from "@/app/checkout/plans/consultation/[planId]/page";
import SubscriptionCheckoutPage from "@/app/checkout/plans/subscription/[planId]/page";

const future = (hours: number) =>
  new Date(Date.now() + hours * 3_600_000).toISOString();

const consultantProfile = {
  id: "cp1",
  headline: "Career coach",
  domain: null,
  user: { id: "u1", name: "Asha Rao", image: "", workExperiences: [] },
};
const basePlan = {
  id: "plan1",
  title: "Plan title",
  price: 99950,
  consultantProfile,
  language: "English",
  level: "ALL_LEVELS",
  durationInHours: 1,
  durationInMonths: 1,
  sessionsPerWeek: 2,
  maxParticipants: 10,
  refundWindowHours: 24,
};

const PLANS: Record<string, unknown> = {
  "/api/plans/webinars/plan1": {
    data: {
      ...basePlan,
      webinars: [
        {
          id: "w1",
          status: "SCHEDULED",
          appointment: {
            occurrences: [{ startsAt: future(48), endsAt: future(49) }],
            _count: { participants: 1 },
          },
        },
      ],
    },
  },
  "/api/plans/classes/plan1": {
    data: { ...basePlan, classes: [{ id: "c1", appointment: null }] },
  },
  "/api/plans/consultations/plan1": { data: basePlan },
  "/api/plans/subscriptions/plan1": {
    data: { ...basePlan, totalSessions: 8, totalHours: 8 },
  },
};

beforeEach(() => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body =
      url === "/api/checkout/context"
        ? {
            buyerCountry: "IN",
            isInternational: false,
            exportZeroRated: false,
            gstRegistered: true,
            billingStateCode: "06",
            referralCreditsPaise: 0,
          }
        : url === "/api/referrals/credits/available"
          ? { data: { totalAvailable: 0 } }
          : url.startsWith("/api/checkout/referral-pricing")
            ? { welcomeDiscount: null, creditCapBps: 0 }
            : PLANS[url];
    return { ok: body !== undefined, status: 200, json: async () => body };
  }) as unknown as typeof fetch;
});

function renderPage(page: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Suspense fallback={null}>{page}</Suspense>
    </QueryClientProvider>,
  );
}

const resolved = <T,>(value: T) =>
  Object.assign(Promise.resolve(value), { __value: value });
const params = resolved({ planId: "plan1" });
const search = (query: Record<string, string>) => resolved(query);

// 999.50 + 18% GST = 1,179.41: not a whole rupee, so the paise must show.
async function findPricedCheckout(title: string) {
  const heading = await screen.findByText(title, {}, { timeout: 4000 });
  const total = await screen.findByText("₹1,179.41");
  return { heading, total };
}

describe("shared plan checkout", () => {
  it("renders the webinar checkout", async () => {
    renderPage(
      <WebinarCheckoutPage
        params={params}
        searchParams={search({ eventId: "w1" })}
      />,
    );
    const { heading, total } = await findPricedCheckout("Webinar Pricing");
    expect(heading).toBeTruthy();
    expect(total).toBeTruthy();
    expect(screen.getByText("Pay with Razorpay")).toBeTruthy();
  });

  it("renders the class checkout", async () => {
    renderPage(
      <ClassCheckoutPage
        params={params}
        searchParams={search({ eventId: "c1" })}
      />,
    );
    const { heading, total } = await findPricedCheckout("Class Pricing");
    expect(heading).toBeTruthy();
    expect(total).toBeTruthy();
    expect(screen.getByText("Pay with Razorpay")).toBeTruthy();
  });

  it("renders the consultation checkout", async () => {
    renderPage(
      <ConsultationCheckoutPage
        params={params}
        searchParams={search({
          startsAt: future(48),
          endsAt: future(49),
          availabilityWindowWeeklyId: "aw1",
        })}
      />,
    );
    const { heading, total } = await findPricedCheckout("Consultation Pricing");
    expect(heading).toBeTruthy();
    expect(total).toBeTruthy();
    expect(screen.getByText("Pay with Razorpay")).toBeTruthy();
  });

  it("a free consultation offers one confirm button and no payer, method or refund copy", async () => {
    PLANS["/api/plans/consultations/free"] = {
      data: { ...basePlan, price: 0 },
    };
    renderPage(
      <ConsultationCheckoutPage
        params={resolved({ planId: "free" })}
        searchParams={search({
          startsAt: future(48),
          endsAt: future(49),
          availabilityWindowWeeklyId: "aw1",
        })}
      />,
    );
    await screen.findByRole(
      "button",
      { name: "Confirm booking" },
      { timeout: 4000 },
    );
    expect(screen.queryByText("Pay with Razorpay")).toBeNull();
    expect(screen.queryByText(/Billing state/)).toBeNull();
    expect(screen.queryByText("Includes")).toBeNull();
    expect(screen.queryByText(/If you cancel/)).toBeNull();
  });

  it("a fully booked subscription checkout says so on its disabled pay button", async () => {
    const answer = global.fetch as jest.Mock;
    const routed = answer.getMockImplementation()!;
    answer.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).startsWith("/api/plans/subscriptions/plan1/feasibility")
        ? {
            ok: true,
            status: 200,
            json: async () => ({
              verdict: "ok",
              firstWeekPlaceable: 2,
              sessionsPerWeek: 2,
              notice: null,
              fullyBooked: true,
            }),
          }
        : routed(input),
    );
    renderPage(
      <SubscriptionCheckoutPage
        params={params}
        searchParams={search({ schedulingPeriodStartsAt: future(96) })}
      />,
    );
    const button = await screen.findByRole(
      "button",
      { name: "Fully booked" },
      { timeout: 4000 },
    );
    expect(button).toHaveProperty("disabled", true);
    expect(screen.queryByText("Pay with Razorpay")).toBeNull();
    expect(screen.queryByText("Sold out")).toBeNull();
  });

  it("renders the subscription checkout with the pay-now line", async () => {
    renderPage(
      <SubscriptionCheckoutPage params={params} searchParams={search({})} />,
    );
    const { heading, total } = await findPricedCheckout("Subscription Pricing");
    expect(heading).toBeTruthy();
    expect(total).toBeTruthy();
    expect(screen.getByText("Pay with Razorpay")).toBeTruthy();
    expect(await screen.findByText(/You pay/)).toBeTruthy();
  });
});
