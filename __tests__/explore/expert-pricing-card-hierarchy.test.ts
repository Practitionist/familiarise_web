/**
 * @jest-environment node
 */

/**
 * The expert storefront keys each offering by its own title, with the session
 * length as metadata above it. Two things are pinned here:
 *
 *   1. Session length reads as a buyer would say it ("60 mins"), never as the
 *      stored Float. The old label interpolated `durationInHours` directly, so
 *      a 30-minute plan rendered "Available 0.5 hour Slots".
 *   2. Plans of equal length stay distinguishable. Keying by duration collapsed
 *      an expert's several 60-minute offerings into "1 Hour (1)", "(2)", …
 */

import {
  formatSessionLength,
  formatSessionLengthModifier,
} from "@/app/explore/experts/[consultantId]/utils/session-length";

describe("formatSessionLength", () => {
  it("renders sub-hour lengths in minutes", () => {
    expect(formatSessionLength(0.5)).toBe("30 mins");
  });

  it("renders exactly one hour as 60 mins, not 1 hour", () => {
    expect(formatSessionLength(1)).toBe("60 mins");
  });

  it("renders fractional lengths in minutes", () => {
    expect(formatSessionLength(1.5)).toBe("90 mins");
  });

  it("switches to hours from two hours up", () => {
    expect(formatSessionLength(2)).toBe("2 hours");
    expect(formatSessionLength(4)).toBe("4 hours");
  });

  it("keeps minutes for a non-whole hour above two hours", () => {
    expect(formatSessionLength(2.5)).toBe("150 mins");
  });

  it("returns an empty string for a length that cannot be rendered", () => {
    expect(formatSessionLength(0)).toBe("");
    expect(formatSessionLength(-1)).toBe("");
    expect(formatSessionLength(Number.NaN)).toBe("");
    expect(formatSessionLength(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("survives float imprecision on a value the schema accepts", () => {
    // 0.1 + 0.2 style drift must not render as "30.000000000000004 mins".
    expect(formatSessionLength(0.1 + 0.2)).toBe("18 mins");
    // Rounds to a clean hour, so it takes the hours branch, not "119 mins".
    expect(formatSessionLength(1.1 + 0.9)).toBe("2 hours");
  });
});

describe("formatSessionLengthModifier", () => {
  it("renders an attributive form for a session", () => {
    expect(formatSessionLengthModifier(0.5)).toBe("30-min");
    // Reads as "a 1-hour session", where the storefront label reads "60 mins".
    expect(formatSessionLengthModifier(1)).toBe("1-hour");
    expect(formatSessionLengthModifier(2)).toBe("2-hour");
    expect(formatSessionLengthModifier(1.5)).toBe("90-min");
  });

  it("returns an empty string for a length that cannot be rendered", () => {
    expect(formatSessionLengthModifier(0)).toBe("");
  });
});

describe("storefront card hierarchy", () => {
  // Mirrors the shape ExpertPricing maps onto PricingOption. The regression
  // this guards is the mapping itself, so the fixture is the mapping's input.
  const plan = (over: Partial<Record<string, unknown>> = {}) => ({
    id: "plan-1",
    title: "Mock interview",
    subtitle: "A realistic 60-minute mock interview",
    description: null,
    durationInHours: 1,
    price: 100000,
    priceCurrency: "INR",
    isFeatured: false,
    ...over,
  });

  const toOption = (p: ReturnType<typeof plan>) => ({
    // The expert's title heads the card.
    title: p.title,
    // The length is metadata, rendered through the formatter.
    duration: formatSessionLength(p.durationInHours),
    isFeatured: p.isFeatured,
  });

  it("titles each offering with the expert's own name for it", () => {
    const sixSameLength = [
      plan({ id: "a", title: "Mock interview" }),
      plan({ id: "b", title: "Career Strategy Session" }),
      plan({ id: "c", title: "API Architecture Review" }),
      plan({ id: "d", title: "Resume Review" }),
      plan({ id: "e", title: "RAG design review" }),
      plan({ id: "f", title: "Production readiness audit" }),
    ];

    const labels = sixSameLength.map((p) => toOption(p).title);

    expect(new Set(labels).size).toBe(6);
    expect(labels).not.toContain("1 Hour (1)");
    expect(labels).not.toContain("1 Hour (2)");
    expect(labels).toContain("Mock interview");
    expect(labels).toContain("Resume Review");
  });

  it("shows the same length as metadata on every equal-length offering", () => {
    const durations = [
      plan({ title: "Mock interview" }),
      plan({ title: "Resume Review" }),
    ].map((p) => toOption(p).duration);

    expect(durations).toEqual(["60 mins", "60 mins"]);
  });

  it("carries the featured flag onto the option so the card can badge it", () => {
    expect(toOption(plan({ isFeatured: true })).isFeatured).toBe(true);
    expect(toOption(plan({ isFeatured: false })).isFeatured).toBe(false);
  });
});
