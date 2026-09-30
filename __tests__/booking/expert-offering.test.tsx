jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: null }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => mockSearchParams,
}));
jest.mock("../../hooks/useTimezone", () => ({
  useTimezone: () => ({ timezone: "UTC", isLoading: false }),
}));
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("../../hooks/useCurrency", () => ({
  useCurrency: () => ({ formatPrice: (price: number) => `₹${price / 100}` }),
}));
jest.mock(
  "../../app/explore/experts/[consultantId]/components/AboutSection",
  () => ({ AboutSection: () => null }),
);
jest.mock(
  "../../app/explore/experts/[consultantId]/components/ExperienceSection",
  () => ({ ExperienceSection: () => null }),
);
jest.mock(
  "../../app/explore/experts/[consultantId]/components/ClassesAndWebinars",
  () => ({ ClassesAndWebinars: () => null }),
);
jest.mock(
  "../../app/explore/experts/[consultantId]/components/ReviewsSection",
  () => ({ ReviewsSection: () => null }),
);
jest.mock("../../components/reviews/ProfileReviewComposer", () => ({
  ProfileReviewComposer: () => null,
}));
jest.mock(
  "../../app/explore/experts/[consultantId]/components/TrialBookingModal",
  () => ({ TrialBookingModal: () => null }),
);
jest.mock("../../components/booking/NotifyWhenFreeButton", () => ({
  HELD_BY_SOMEONE_ELSE: new Set(),
  NotifyWhenFreeButton: () => null,
}));
jest.mock("../../utils/scheduling-engine/intervals", () => ({
  breakDownSlotsPreservingStatus: (slots: unknown[]) => slots,
}));

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExpertProfileClient } from "@/app/explore/experts/[consultantId]/ExpertProfileClient";
import { resolveOffering } from "@/app/explore/experts/[consultantId]/offering-selection";
import type { ConsultantDetailData } from "@/app/explore/experts/[consultantId]/types";
import type { TUserWithProfessionalBackground } from "@/types/user";

const plan = {
  subtitle: "",
  whatsIncluded: [],
  learningOutcomes: [],
  priceCurrency: "INR",
};
const details = {
  id: "expert",
  bookingMode: "INSTANT",
  acceptingRequests: true,
  publishedRatingOneToOne: null,
  publishedRatingGroup: null,
  ratedClientsOneToOne: 0,
  ratedEventsGroup: 0,
  consultationPlans: [
    {
      ...plan,
      id: "career",
      title: "Career conversation",
      durationInHours: 1,
      price: 10000,
      learningOutcomes: ["Clarify your next move"],
    },
    {
      ...plan,
      id: "portfolio",
      title: "Portfolio review",
      durationInHours: 1,
      price: 15000,
      learningOutcomes: ["Improve your portfolio"],
    },
  ],
  subscriptionPlans: [
    {
      ...plan,
      id: "mentorship",
      title: "Career mentorship",
      durationInMonths: 3,
      price: 100000,
      totalHours: 12,
      totalSessions: 12,
      sessionsPerWeek: 1,
      sessionDurationInHours: 1,
      emailSupport: "NONE",
      subscriptionContents: [
        { id: "b", title: "Build your portfolio", order: 2, outcomes: [] },
        {
          id: "a",
          title: "Set your goals",
          order: 1,
          outcomes: ["A clear direction"],
        },
        { id: "c", title: "Practice interviews", order: 3, outcomes: [] },
        { id: "d", title: "Next steps", order: 4, outcomes: [] },
      ],
    },
  ],
  _count: { reviews: 0 },
  domain: { name: "Careers" },
  user: { name: "Alex" },
} as unknown as ConsultantDetailData;
const user = {
  id: "expert-user",
  name: "Alex",
  timezone: "UTC",
} as TUserWithProfessionalBackground;
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const fetchMock = jest.fn();
let mockSearchParams = new URLSearchParams();
const click = async (label: string) => {
  const matches = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).filter(
    (item) =>
      item.textContent?.trim() === label ||
      item.getAttribute("aria-label") === label,
  );
  expect(matches).toHaveLength(1);
  await act(async () => matches[0].click());
};
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockSearchParams = new URLSearchParams();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock
    .mockReset()
    .mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
  global.fetch = fetchMock;
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  jest.restoreAllMocks();
});
const render = async (consultantDetails = details) => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ExpertProfileClient
          consultantDetails={consultantDetails}
          userDetails={user}
          reviews={[]}
          reviewTracks={{ ONE_TO_ONE: false, GROUP: false }}
        />
      </QueryClientProvider>,
    ),
  );
};

it("uses plan identity for defaults, links and category changes", () => {
  expect(resolveOffering(details, "portfolio")).toEqual({
    service: "consultations",
    planId: "portfolio",
  });
  expect(resolveOffering(details, "mentorship")).toEqual({
    service: "subscriptions",
    planId: "mentorship",
  });
  expect(resolveOffering(details, "mentorship", "consultations").planId).toBe(
    "career",
  );
  expect(resolveOffering(details, "missing").planId).toBe("career");
  expect(
    resolveOffering(
      { consultationPlans: [], subscriptionPlans: [{ id: "only" }] },
      null,
      "consultations",
    ),
  ).toEqual({ service: "subscriptions", planId: "only" });
});

it("shares selection across preview, price and details without loading availability", async () => {
  await render();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(
    document.querySelector('nav[aria-label="Breadcrumb"]')?.textContent,
  ).toContain("ExpertsAlex");
  expect(document.body.textContent).not.toContain("Back to Experts");
  expect(document.body.textContent).not.toContain("Document verification");
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[role="radio"][value="portfolio"]')!
      .click(),
  );
  expect(document.querySelector("#offering-preview-title")?.textContent).toBe(
    "Portfolio review",
  );
  expect(document.body.textContent).toContain("₹150");
  expect(
    document.querySelector(
      'a[href="/explore/programs/plans/consultations/portfolio"]',
    ),
  ).not.toBeNull();
  expect(document.body.textContent).not.toContain("Clarify your next move");
  expect(fetchMock).not.toHaveBeenCalled();
  await click("Choose a time");
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("shows three authored mentorship milestones and the actual scheduling contract", async () => {
  await render();
  const tab = document.querySelector<HTMLButtonElement>(
    '[role="tab"][data-state="inactive"]',
  )!;
  await act(async () =>
    tab.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    ),
  );
  expect(document.querySelector("#offering-preview-title")?.textContent).toBe(
    "Career mentorship",
  );
  expect(document.body.textContent).toContain("Set your goals");
  expect(document.body.textContent).toContain("Practice interviews");
  expect(document.body.textContent).not.toContain("Next steps");
  expect(document.body.textContent).toContain(
    "Session dates are arranged with your expert after purchase.",
  );
  expect(document.querySelector('[role="radiogroup"]')).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("honours plan deep links and keeps an open calendar live when the URL selects another plan", async () => {
  mockSearchParams = new URLSearchParams("plan=portfolio");
  await render();
  expect(document.querySelector("#offering-preview-title")?.textContent).toBe(
    "Portfolio review",
  );
  expect(fetchMock).not.toHaveBeenCalled();
  await click("Choose a time");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  mockSearchParams = new URLSearchParams("plan=career&conflict=1");
  await render();
  expect(document.querySelector("#offering-preview-title")?.textContent).toBe(
    "Career conversation",
  );
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(
    fetchMock.mock.calls
      .slice(2)
      .every(([, options]) => options?.cache === "no-store"),
  ).toBe(true);
  await click("Next month");
  expect(fetchMock).toHaveBeenCalledTimes(5);
});
