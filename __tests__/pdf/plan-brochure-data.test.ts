import {
  brochureFilename,
  createPlanBrochureData,
  type BrochureSource,
} from "@/lib/pdf/plan-brochure-data";

const basePlan: BrochureSource = {
  id: "plan-1",
  title: "System Design Mastery",
  subtitle: "From fundamentals to distributed scale",
  description: "Hands-on system design mentorship and architecture reviews.",
  price: 150000,
  priceCurrency: "INR",
  language: "English",
  level: "ADVANCED",
  durationInMonths: 2,
  durationInHours: 1.5,
  sessionsPerWeek: 2,
  totalSessions: 8,
  totalHours: 12,
  maxParticipants: 25,
  trialEnabled: true,
  learningOutcomes: ["Design high-throughput services", ""],
  targetAudience: ["Senior engineers", ""],
  whatsIncluded: ["Architecture review templates", ""],
  prerequisites: "3+ years of backend experience",
  materialProvided: "System design workbook",
  topics: [{ id: "t1", name: "Distributed Systems" }, "Caching", ""],
  faqs: [
    { question: "Are sessions recorded?", answer: "Yes, for 30 days." },
    { question: "", answer: "Ignored" },
  ],
  consultantProfile: {
    headline: "Principal Architect",
    user: { name: "Aarav Mehta" },
  },
  classContents: [
    {
      title: "Consistent Hashing",
      description: "Partitioning & replication",
      order: 2,
      hoursAllotted: 2,
      outcomes: ["Ring partitioning"],
    },
    {
      title: "Foundations",
      description: "Latency & throughput",
      order: 1,
      hoursAllotted: 1.5,
      outcomes: ["Little's Law"],
    },
  ],
  subscriptionContents: [
    {
      title: "Roadmap Kickoff",
      description: "Goal setting & gap analysis",
      order: 1,
      hoursAllotted: 1,
    },
  ],
};

describe("createPlanBrochureData", () => {
  it("builds brochure data for classes with sorted curriculum", () => {
    const data = createPlanBrochureData(
      basePlan,
      "classes",
      "https://familiarise.com",
      new Date("2026-10-01T00:00:00Z"),
    );
    expect(data.kind).toBe("Expert-led class");
    expect(data.curriculumHeading).toBe("Course content");
    expect(data.curriculum.map((c) => c.order)).toEqual([1, 2]);
    expect(data.learningOutcomes).toEqual(["Design high-throughput services"]);
    expect(data.topics).toEqual(["Distributed Systems", "Caching"]);
    expect(data.faqs).toHaveLength(1);
    expect(data.planUrl).toBe(
      "https://familiarise.com/explore/programs/plans/classes/plan-1",
    );
  });

  it("builds brochure data for consultations and normalizes empty strings to null", () => {
    const data = createPlanBrochureData(
      {
        ...basePlan,
        subtitle: "",
        description: "",
        prerequisites: "None",
        materialProvided: "",
      },
      "consultations",
      "https://familiarise.com",
    );
    expect(data.kind).toBe("1:1 consultation");
    expect(data.subtitle).toBeNull();
    expect(data.description).toBeNull();
    expect(data.prerequisites).toBeNull();
    expect(data.materialProvided).toBeNull();
    expect(data.facts).toContain("One-to-one");
    expect(data.curriculum).toEqual([]);
  });

  it("builds brochure data for subscriptions and webinars", () => {
    const subData = createPlanBrochureData(
      basePlan,
      "subscriptions",
      "https://familiarise.com",
    );
    expect(subData.kind).toBe("Mentorship programme");
    expect(subData.facts).toContain("Trial available");
    expect(subData.curriculum).toHaveLength(1);

    const webinarData = createPlanBrochureData(
      basePlan,
      "webinars",
      "https://familiarise.com",
    );
    expect(webinarData.kind).toBe("Live webinar");
    expect(webinarData.curriculum).toEqual([]);
  });

  it("generates a clean ASCII filename slug", () => {
    expect(brochureFilename("1:1 Résumé & Career Review!")).toBe(
      "1-1-resume-career-review-brochure.pdf",
    );
    expect(brochureFilename("   ")).toBe("familiarise-plan-brochure.pdf");
  });
});
