/**
 * What an unverified expert's own surfaces say, and what a learner holding an
 * old link sees: a published offering reads "Live once verified" with no share
 * link that would 404, a hidden plan's checkout says it isn't available rather
 * than a raw status, and a verification flip purges the program listings.
 */
import type { ReactNode } from "react";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
// The share attribution reads the signed-in session, which this render has none of.
jest.mock("@/hooks/useExpertShareHref", () => ({
  appendExpertShareAttribution: (href: string) => href,
}));
jest.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: null, isPending: false }),
}));
const mockRevalidateTag = jest.fn();
jest.mock("next/cache", () => ({
  revalidateTag: (tag: string) => mockRevalidateTag(tag),
  revalidatePath: jest.fn(),
}));

import { OfferingCard } from "@/components/offerings/list/OfferingCard";
import { buildOfferingRows } from "@/components/offerings/list/offering-rows";
import { planLoadError } from "@/app/checkout/plans/adapters/shared";
import { LoadError } from "@/app/checkout/plans/components/PlanCheckoutShell";
import { consultantNavWithPublicPage } from "@/lib/dashboard/nav/consultant";
import { purgeExpertSurfaces } from "@/lib/data/public-cache";
import { useOfferingsListed } from "@/hooks/useVerificationStatus";

const row = buildOfferingRows({
  consultationPlans: [
    {
      id: "evt",
      consultationPlan: {
        id: "plan-1",
        title: "Career clarity",
        status: "PUBLISHED",
        price: 150_000,
        priceCurrency: "INR",
        durationInHours: 1,
      },
    } as never,
  ],
  subscriptionPlans: [],
  webinars: [],
  classes: [],
  participantCounts: {},
})[0];

const card = (listed: boolean | null) =>
  render(
    <OfferingCard
      row={row}
      editHref="/edit"
      duplicateHref={null}
      listed={listed}
    />,
  );

it("tells an unverified expert a published offering is not live yet, with no share link", () => {
  card(false);
  expect(screen.getByText("Live once verified")).toBeTruthy();
  expect(screen.queryByText("Published")).toBeNull();
  expect(screen.queryByText("Share link")).toBeNull();
});

it("keeps the published chip and share link for a verified expert", () => {
  card(true);
  expect(screen.getByText("Published")).toBeTruthy();
  expect(screen.getByText("Share link")).toBeTruthy();
});

it("shows neither chip nor share link while the expert's standing is unknown, holding the chip's place", () => {
  card(null);
  expect(screen.queryByText("Published")).toBeNull();
  expect(screen.queryByText("Live once verified")).toBeNull();
  expect(screen.queryByText("Share link")).toBeNull();
  // The same badge, invisible and empty, so the card does not shift when the chip lands.
  expect(
    screen.getByTestId("chip-placeholder").getAttribute("aria-hidden"),
  ).toBe("true");
});

it("drops the placeholder once the standing is known", () => {
  card(false);
  expect(screen.queryByTestId("chip-placeholder")).toBeNull();
});

describe("the planner's listing state", () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {children}
    </QueryClientProvider>
  );
  /** The status endpoint's answer; `null` keeps the request in flight. */
  const statusAnswer = (verificationStatus: string | null) => {
    const body = {
      success: true,
      data: {
        profileId: "cp-1",
        isVerified: verificationStatus === "VERIFIED",
        verificationStatus,
        linkedinUrl: null,
        latestRequest: null,
      },
    };
    global.fetch = jest.fn(() =>
      verificationStatus === null
        ? new Promise(() => {})
        : Promise.resolve({ ok: true, json: async () => body }),
    ) as unknown as typeof fetch;
  };

  it("is unknown while the owner's standing loads, so nothing flashes", () => {
    statusAnswer(null);
    const { result } = renderHook(() => useOfferingsListed("u-1", true), {
      wrapper,
    });
    expect(result.current).toBeNull();
  });

  it("follows the owner's standing once it loads", async () => {
    statusAnswer("UNDER_REVIEW");
    const pending = renderHook(() => useOfferingsListed("u-1", true), {
      wrapper,
    });
    await waitFor(() => expect(pending.result.current).toBe(false));
    statusAnswer("VERIFIED");
    const verified = renderHook(() => useOfferingsListed("u-2", true), {
      wrapper,
    });
    await waitFor(() => expect(verified.result.current).toBe(true));
  });

  it("is listed for a viewer who does not own the planner", () => {
    statusAnswer(null);
    const { result } = renderHook(() => useOfferingsListed("u-1", false), {
      wrapper,
    });
    expect(result.current).toBe(true);
  });
});

it("answers a hidden plan's checkout with a plain sentence, never the status code", () => {
  expect(planLoadError(404).message).toBe(
    "This plan isn't available to book right now. Browse other experts to find another.",
  );
  expect(planLoadError(500).message).not.toMatch(/\d{3}/);
});

it("offers Browse experts beside Go back, under a title that is not a fault, for an unavailable plan", () => {
  render(<LoadError message={planLoadError(404).message} recovery={null} />);
  expect(screen.getByText("This plan isn't available")).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "Browse experts" }).getAttribute("href"),
  ).toBe("/explore/experts");
  expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy();
});

it("keeps Go back alone and the generic title for a load failure", () => {
  render(<LoadError message={planLoadError(500).message} recovery={null} />);
  expect(screen.getByText("Unable to load checkout")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Browse experts" })).toBeNull();
});

describe("the expert header's public-page link", () => {
  const nav = (status: string | null | undefined) =>
    consultantNavWithPublicPage("cp-1", "/explore/experts/cp-1?via=t", status);

  it("keeps the link and copies the share link for a verified expert", () => {
    expect(nav("VERIFIED").pinnedCta).toMatchObject({
      label: "View public page",
      copyText: "/explore/experts/cp-1?via=t",
    });
  });

  it("drops both controls while the expert is known not to be verified", () => {
    expect(nav("UNDER_REVIEW").pinnedCta).toBeUndefined();
    expect(nav("PENDING_VERIFICATION").pinnedCta).toBeUndefined();
  });

  it("keeps the link while the standing is still loading", () => {
    expect(nav(undefined).pinnedCta?.label).toBe("View public page");
  });
});

it("purges the program listings when an expert's standing changes", () => {
  purgeExpertSurfaces("cp-1");
  expect(mockRevalidateTag).toHaveBeenCalledWith("programs");
});
