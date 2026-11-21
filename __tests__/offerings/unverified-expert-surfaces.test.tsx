/**
 * What an unverified expert's own surfaces say, and what a learner holding an
 * old link sees: a published offering reads "Live once verified" with no share
 * link that would 404, a hidden plan's checkout says it isn't available rather
 * than a raw status, and a verification flip purges the program listings.
 */
import { render, screen } from "@testing-library/react";

jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
// The share attribution reads the signed-in session, which this render has none of.
jest.mock("@/hooks/useExpertShareHref", () => ({
  appendExpertShareAttribution: (href: string) => href,
}));
const mockRevalidateTag = jest.fn();
jest.mock("next/cache", () => ({
  revalidateTag: (tag: string) => mockRevalidateTag(tag),
  revalidatePath: jest.fn(),
}));

import { OfferingCard } from "@/components/offerings/list/OfferingCard";
import { buildOfferingRows } from "@/components/offerings/list/offering-rows";
import { planLoadError } from "@/app/checkout/plans/adapters/shared";
import { purgeExpertSurfaces } from "@/lib/data/public-cache";

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

const card = (listed: boolean) =>
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

it("answers a hidden plan's checkout with a plain sentence, never the status code", () => {
  expect(planLoadError(404).message).toBe(
    "This plan isn't available to book right now. Browse other experts to find another.",
  );
  expect(planLoadError(500).message).not.toMatch(/\d{3}/);
});

it("purges the program listings when an expert's standing changes", () => {
  purgeExpertSurfaces("cp-1");
  expect(mockRevalidateTag).toHaveBeenCalledWith("programs");
});
