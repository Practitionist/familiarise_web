/** @jest-environment node */
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (file: string) =>
  readFileSync(path.join(process.cwd(), file), "utf8");

// No placement is paid for: every curated row is ordered by rating or activity,
// so its label has to say so. See the owner decisions on the 2026 consumer rules.
const RANKED_SURFACES = [
  "app/explore/experts/components/FeaturedExperts.tsx",
  "app/explore/experts/components/StaticTopRows.tsx",
  "app/explore/experts/components/ExpertMiniCard.tsx",
  "app/explore/experts/components/SearchBar.tsx",
  "app/explore/experts/hooks/useExpertFilterChips.ts",
  "app/explore/programs/components/StaticTopRows.tsx",
  "app/explore/programs/components/ProgramCard.tsx",
  "components/home/FeaturedExpertsSection.tsx",
];

const BANNED = [
  "Familiarise Pick",
  "Top Familiarise",
  "best of the best",
  "Familiarise Featured",
  "Featured Experts",
  "Trending Experts",
  "Trending Now",
];

describe("ranking labels", () => {
  it.each(RANKED_SURFACES)("%s uses no promotional ranking wording", (file) => {
    const source = read(file);
    for (const phrase of BANNED) expect(source).not.toContain(phrase);
  });

  it("names what each curated row is sorted by", () => {
    expect(
      read("app/explore/experts/components/FeaturedExperts.tsx"),
    ).toContain("Highest rated");
    expect(read("app/explore/experts/components/StaticTopRows.tsx")).toContain(
      "Recently reviewed experts",
    );
    expect(read("app/explore/programs/components/StaticTopRows.tsx")).toContain(
      "Most booked this month",
    );
  });
});

describe("mentorship plan price period", () => {
  const toggle = read(
    "app/explore/experts/[consultantId]/components/SubscriptionPricingToggle.tsx",
  );

  it("says the price is for the whole plan, never per month", () => {
    expect(toggle).toContain("for {planDurationText(option)}");
    expect(toggle).not.toMatch(/\/\s*month/);
  });
});
