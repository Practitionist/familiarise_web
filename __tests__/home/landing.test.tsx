/** @jest-environment node */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FamiliariseLogo } from "@/components/brand/FamiliariseLogo";
import { FAMILIARISE_MARK_PATHS } from "@/lib/brand";
import {
  homePortrait,
  nameInitials,
  selectHomeSpotlight,
  type HomeExpert,
} from "@/lib/home/landing-content";
import { ProductPreview } from "@/components/home/ProductPreview";
import { LandingHero } from "@/components/home/LandingHero";
import { LandingDiscovery } from "@/components/home/LandingDiscovery";
import { LandingReviews } from "@/components/home/LandingReviews";
import { LandingFormats } from "@/components/home/LandingSections";
import type { TPublicConsultantReview } from "@/types/review";

function expert(id = "expert-a"): HomeExpert {
  return {
    id,
    rating: null,
    headline: "Career mentor",
    experience: 7,
    description: null,
    createdAt: new Date("2026-01-01"),
    user: {
      id: `user-${id}`,
      name: "Alex Taylor",
      image: "https://avatars.githubusercontent.com/seeded-user",
      profileDisplayImage: null,
    },
    domain: { id: "domain-careers", name: "Career guidance" },
    subDomains: [],
    tags: [{ id: "tag-strategy", name: "Career strategy" }],
    subscriptionPlans: [],
  };
}

function plan(
  id = "plan-a",
  contents = [{ id: "content-a", title: "Define your direction", order: 1 }],
) {
  return {
    id,
    title: "Career mentorship",
    price: 123456,
    priceCurrency: "INR",
    durationInMonths: 3,
    sessionsPerWeek: 1,
    emailSupport: null,
    totalSessions: 12,
    trialEnabled: false,
    trialPriceInPaise: 0,
    subscriptionContents: contents,
  };
}

function review(
  id = "review-a",
  overrides: Partial<TPublicConsultantReview> = {},
): TPublicConsultantReview {
  return {
    id,
    rating: 4.5,
    isAnonymous: false,
    reviewDescription:
      "A thoughtful conversation that helped me see my next step.",
    consultantProfileId: "expert-a",
    consultantProfile: { user: { name: "Alex Taylor" } },
    consulteeProfile: {
      user: { name: "Morgan Chen", image: "https://example.com/avatar.jpg" },
    },
    editedAt: null,
    replyBody: null,
    ...overrides,
  } as TPublicConsultantReview;
}

describe("landing content selection", () => {
  it("prefers actual authored curriculum over a profile-only expert", () => {
    const withPlan = { ...expert("expert-b"), subscriptionPlans: [plan()] };
    expect(selectHomeSpotlight([expert(), withPlan])?.expert.id).toBe(
      "expert-b",
    );
  });

  it("chooses an authored plan, sorts a copy, ignores blank titles, and caps the preview", () => {
    const contents = [
      { id: "d", title: "Next steps", order: 4 },
      { id: "b", title: "Build your portfolio", order: 2 },
      { id: "a", title: "Set goals", order: 1 },
      { id: "empty", title: "  ", order: 0 },
      { id: "c", title: "Practice interviews", order: 3 },
    ];
    const input = {
      ...expert(),
      subscriptionPlans: [plan("empty", []), plan("authored", contents)],
    };
    const selected = selectHomeSpotlight([input]);
    expect(selected?.plan?.id).toBe("authored");
    expect(selected?.milestones.map((item) => item.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(contents.map((item) => item.id)).toEqual([
      "d",
      "b",
      "a",
      "empty",
      "c",
    ]);
  });

  it("returns no spotlight for an empty catalogue", () => {
    expect(selectHomeSpotlight([])).toBeNull();
  });

  it("supports an expert without any offering", () => {
    expect(selectHomeSpotlight([expert()])?.milestones).toEqual([]);
    expect(selectHomeSpotlight([expert()])?.plan).toBeUndefined();
  });

  it("uses intentional display photos instead of third-party account avatars", () => {
    expect(homePortrait(expert())).toBeUndefined();
    const approved = expert();
    approved.user.profileDisplayImage = "/approved-portrait.webp";
    expect(homePortrait(approved)).toBe("/approved-portrait.webp");
  });

  it.each([
    [" Alex   Taylor ", "AT"],
    ["Maya", "M"],
    ["", "F"],
    ["Élodie Chen", "ÉC"],
  ])("creates stable initials for %s", (name, initials) => {
    expect(nameInitials(name)).toBe(initials);
  });
});

describe("server-visible landing UI", () => {
  it("renders hero copy and accurate metrics without animation or client JavaScript", () => {
    const html = renderToStaticMarkup(
      <LandingHero
        stats={[
          {
            key: "rating",
            value: 4.7,
            display: "4.7",
            label: "Average Rating",
          },
        ]}
        preview={<div>Offering preview</div>}
      />,
    );
    expect(html).toContain("The right expert.");
    expect(html).toContain("A clearer way forward.");
    expect(html).toContain(">4.7</dd>");
    expect(html).not.toContain("opacity:0");
    expect(html).toContain('href="/explore/experts"');
    expect(html).toContain('href="/explore/programs"');
  });

  it("omits the metrics row when no eligible figures exist", () => {
    expect(
      renderToStaticMarkup(<LandingHero stats={[]} preview={null} />),
    ).not.toContain("Familiarise community");
  });

  it("links an actual offering without promising prices, dates, or availability", () => {
    const html = renderToStaticMarkup(
      <ProductPreview
        experts={[{ ...expert(), subscriptionPlans: [plan()] }]}
      />,
    );
    expect(html).toContain("Define your direction");
    expect(html).toContain(
      'href="/explore/programs/plans/subscriptions/plan-a"',
    );
    expect(html).not.toContain("123456");
    expect(html).not.toContain("slots available");
    expect(html).not.toContain("contentUrl");
  });

  it("does not fabricate curriculum for an offering with no authored milestones", () => {
    const html = renderToStaticMarkup(
      <ProductPreview
        experts={[{ ...expert(), subscriptionPlans: [plan("empty", [])] }]}
      />,
    );
    expect(html).not.toContain("Curriculum preview");
    expect(html).toContain("review what&#x27;s included");
  });

  it("keeps an empty-catalogue hero useful without a fake expert card", () => {
    const html = renderToStaticMarkup(<ProductPreview experts={[]} />);
    expect(html).toContain("Start with what matters to you.");
    expect(html).not.toContain("Verified expert");
  });

  it("uses canonical domain IDs and hides null ratings instead of displaying zero", () => {
    const html = renderToStaticMarkup(
      <LandingDiscovery
        experts={[expert()]}
        domains={[{ id: "domain-careers", name: "Career guidance", count: 1 }]}
      />,
    );
    expect(html).toContain('href="/explore/experts?domain=domain-careers"');
    expect(html).not.toMatch(/>0\.0</);
    expect(html).toContain("Expert profiles");
  });

  it("does not render an empty discovery grid", () => {
    expect(
      renderToStaticMarkup(<LandingDiscovery experts={[]} domains={[]} />),
    ).toBe("");
  });

  it("routes classes and webinars to their supported discovery tabs", () => {
    const html = renderToStaticMarkup(<LandingFormats />);
    expect(html).toContain('href="/explore/programs?tab=class"');
    expect(html).toContain('href="/explore/programs?tab=webinar"');
  });
});

describe("review integrity", () => {
  it("hides anonymous identity even if an unsanitised object is accidentally supplied", () => {
    const html = renderToStaticMarkup(
      <LandingReviews reviews={[review("anonymous", { isAnonymous: true })]} />,
    );
    expect(html).toContain("Anonymous");
    expect(html).not.toContain("Morgan Chen");
    expect(html).not.toContain("avatar.jpg");
  });

  it("never creates a quote when the reviewer supplied no text", () => {
    expect(
      renderToStaticMarkup(
        <LandingReviews
          reviews={[review("blank", { reviewDescription: "  " })]}
        />,
      ),
    ).toBe("");
    expect(renderToStaticMarkup(<LandingReviews reviews={[]} />)).toBe("");
  });

  it("shows three distinct review rows, accurate ratings, edit attribution, and a full-review link", () => {
    const html = renderToStaticMarkup(
      <LandingReviews
        reviews={[
          review("a", {
            editedAt: new Date(),
            replyBody: "Thank you for sharing your experience.",
          }),
          review("b"),
          review("c"),
          review("d"),
        ]}
      />,
    );
    expect(html.match(/<figure/g)).toHaveLength(3);
    expect(html).toContain("4.5");
    expect(html).toContain("Edited");
    expect(html).toContain("Expert response");
    expect(html).toContain("Thank you for sharing your experience.");
    expect(html).toContain('href="/explore/experts/expert-a#reviews"');
  });
});

describe("brand assets", () => {
  it("renders the Familiarise identity without legacy artwork", () => {
    const html = renderToStaticMarkup(<FamiliariseLogo />);
    expect(html).toContain('aria-label="Familiarise"');
    expect(html).toContain("familiarise");
    expect(html).not.toContain("avif");
    expect(html).not.toContain("ConsultX");
  });

  it.each([
    "familiarise-wordmark-dark.svg",
    "familiarise-wordmark-light.svg",
    "familiarise-symbol-dark.svg",
    "familiarise-symbol-light.svg",
    "familiarise-icon.svg",
  ])("exports %s with matching vector geometry", (file) => {
    const svg = readFileSync(
      path.join(process.cwd(), "public/brand", file),
      "utf8",
    );
    for (const geometry of FAMILIARISE_MARK_PATHS)
      expect(svg).toContain(geometry);
    expect(svg).not.toMatch(/<text\b/);
  });

  it("exports a social preview at the declared dimensions", () => {
    const png = readFileSync(
      path.join(process.cwd(), "public/brand/landing-og.png"),
    );
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
  });

  it("refreshes Next's automatic favicon with the matching multi-size icon", () => {
    const ico = readFileSync(
      path.join(process.cwd(), "public/brand/familiarise-favicon.ico"),
    );
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(3);
    expect([ico[6], ico[22], ico[38]]).toEqual([16, 32, 48]);
    expect(readFileSync(path.join(process.cwd(), "app/favicon.ico"))).toEqual(
      ico,
    );
  });

  it("exports the matching home-screen icon at 180px", () => {
    const png = readFileSync(
      path.join(process.cwd(), "public/brand/familiarise-apple-icon.png"),
    );
    expect(png.readUInt32BE(16)).toBe(180);
    expect(png.readUInt32BE(20)).toBe(180);
  });
});
