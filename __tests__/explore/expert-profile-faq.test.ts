/**
 * @jest-environment node
 */

/**
 * The profile answers a buyer's objections without a click through, so it
 * flattens the per-plan FAQ lists into one section. Two rules earn their keep:
 *
 *   - Questions repeat across an expert's plans (the same "what should I
 *     bring?" on every offering). Shown once each, a profile reads thorough;
 *     shown per plan, it reads broken.
 *   - The section is capped, because an unbounded wall of Q&A pushes the
 *     reviews and the booking surface off the page.
 *
 * Order follows the storefront: a question on the expert's top-listed offering
 * outranks the same question further down.
 */

import { collectProfileFaqs } from "@/app/explore/experts/[consultantId]/components/ProfileFaqSection";

type ConsultantPlan = Parameters<typeof collectProfileFaqs>[0][number];
type Faq = ConsultantPlan["faqs"][number];

const EPOCH = new Date(0);

/** A fully-typed plan row. The fixtures stay honest to the fetcher's inferred
 *  shape so a change to the select surfaces here as a compile error rather than
 *  as a cast hiding it. */
const plan = (id: string, faqs: Faq[], sortOrder = 0): ConsultantPlan => ({
  id,
  title: "Mock interview",
  subtitle: null,
  description: null,
  durationInHours: 1,
  price: 100000,
  priceCurrency: "INR",
  language: "English",
  level: "BEGINNER",
  prerequisites: null,
  materialProvided: null,
  learningOutcomes: [],
  targetAudience: [],
  whatsIncluded: [],
  imageUrl: null,
  slug: null,
  recordingEnabled: false,
  sortOrder,
  isFeatured: false,
  status: "PUBLISHED",
  consultantProfileId: "consultant-1",
  organizationId: null,
  visibility: "PUBLIC",
  archivedAt: null,
  createdAt: EPOCH,
  updatedAt: EPOCH,
  faqs,
});

const faq = (id: string, question: string): Faq => ({
  id,
  question,
  answer: `Answer to ${question}`,
  order: 0,
  createdAt: EPOCH,
  updatedAt: EPOCH,
  subscriptionPlanId: null,
  consultationPlanId: "consultant-1",
  webinarPlanId: null,
  classPlanId: null,
});

describe("collectProfileFaqs", () => {
  it("returns nothing when the expert has authored no FAQs", () => {
    expect(collectProfileFaqs([])).toEqual([]);
    expect(collectProfileFaqs([plan("a", [])])).toEqual([]);
  });

  it("flattens FAQs across plans in storefront order", () => {
    const collected = collectProfileFaqs([
      plan("top", [faq("q1", "What should I bring?")], 0),
      plan("second", [faq("q2", "Do you record sessions?")], 1),
    ]);

    expect(collected.map((f) => f.question)).toEqual([
      "What should I bring?",
      "Do you record sessions?",
    ]);
  });

  it("keeps a repeated question once, at its first occurrence", () => {
    const collected = collectProfileFaqs([
      plan("a", [faq("q1", "What should I bring?")]),
      plan("b", [faq("q2", "What should I bring?")]),
      plan("c", [faq("q3", "Do you record sessions?")]),
    ]);

    expect(collected.map((f) => f.question)).toEqual([
      "What should I bring?",
      "Do you record sessions?",
    ]);
  });

  it("treats questions differing only in case or padding as the same question", () => {
    const collected = collectProfileFaqs([
      plan("a", [faq("q1", "What should I bring?")]),
      plan("b", [faq("q2", "  what should i bring?  ")]),
    ]);

    expect(collected).toHaveLength(1);
  });

  it("caps the section so it cannot grow without bound", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      faq(`q${i}`, `Question number ${i}?`),
    );

    expect(collectProfileFaqs([plan("a", many)])).toHaveLength(6);
  });

  it("preserves each question's own answer", () => {
    const collected = collectProfileFaqs([
      plan("a", [faq("q1", "First?"), faq("q2", "Second?")]),
    ]);

    expect(collected[0].answer).toBe("Answer to First?");
    expect(collected[1].answer).toBe("Answer to Second?");
  });
});
