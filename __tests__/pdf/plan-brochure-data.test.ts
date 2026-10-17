/** @jest-environment node */
import {
  brochureFilename,
  createPlanBrochureData,
} from "@/lib/pdf/plan-brochure-data";

const items = [
  {
    id: "private-row",
    title: "Portfolio",
    description: "Build a case study",
    order: 2,
    sectionLabel: "Week 2",
    hoursAllotted: 1,
    outcomes: ["Explain decisions"],
    contentUrl: "https://private.example/lesson",
  },
  {
    title: "Direction",
    description: "Set your goals",
    order: 1,
    sectionLabel: "Week 1",
    hoursAllotted: 1,
  },
];
const source = {
  id: "plan",
  title: "Design mentorship",
  subtitle: "A clear next step",
  description: "Grow with guidance",
  language: "English",
  level: "INTERMEDIATE" as const,
  durationInMonths: 3,
  sessionsPerWeek: 1,
  learningOutcomes: ["Build confidence"],
  targetAudience: ["Designers"],
  whatsIncluded: ["Mentoring sessions"],
  prerequisites: "None",
  consultantProfile: { user: { name: "Maya", email: "private@example.com" } },
  classContents: items,
  subscriptionContents: items,
  price: 123456,
  materials: [{ fileUrl: "https://private.example/material.pdf" }],
  classes: [{ participants: [{ userId: "private-attendee" }] }],
};

it.each(["classes", "subscriptions"] as const)(
  "copies only the page's buyer-facing %s content, in curriculum order",
  (type) => {
    const data = createPlanBrochureData(
      source,
      type,
      "https://familiarise.test",
      new Date("2026-09-30T00:00:00Z"),
    );
    expect(data.curriculum.map((item) => item.title)).toEqual([
      "Direction",
      "Portfolio",
    ]);
    expect(data.facts).toEqual([
      "3 months",
      "1 session per week",
      "Intermediate",
      "English",
    ]);
    expect(data.planUrl).toBe(
      `https://familiarise.test/explore/programs/plans/${type}/plan`,
    );
    expect(data.prerequisites).toBeNull();
    expect(data.generatedAt).toBe("2026-09-30T00:00:00.000Z");
    expect(JSON.stringify(data)).not.toMatch(
      /private|123456|participants|fileUrl|contentUrl/,
    );
  },
);

it("preserves Unicode content and never mutates the authored curriculum", () => {
  const data = createPlanBrochureData(
    { ...source, title: "डिज़ाइन मार्गदर्शन" },
    "subscriptions",
    "https://familiarise.test",
  );
  expect(data.title).toBe("डिज़ाइन मार्गदर्शन");
  expect(items[0].order).toBe(2);
});

it("uses safe download names even for Unicode or header-breaking titles", () => {
  expect(brochureFilename('Design / systems\r\n"bad')).toBe(
    "design-systems-bad-curriculum.pdf",
  );
  expect(brochureFilename("डिज़ाइन")).toBe("familiarise-plan-curriculum.pdf");
});
