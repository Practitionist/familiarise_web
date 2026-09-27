/**
 * @jest-environment node
 */

/**
 * The webinar GET returns `topics` as the `Topic` relation, and a plain
 * object in a `stringList` field crashed `StringListField`'s key derivation
 * (`item.slice`). The adapter must map the relation down to names.
 */

// Same boundary-mock as __tests__/plans/plan-archive-toggle.test.ts: adapters.ts
// pulls schemas/plans, which loads `bad-words` (ESM-only) through
// utils/contentValidation at import time, and lib/prisma via the plan
// services — neither matters to planOf's pure mapping.
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("../../utils/contentValidation", () => ({
  __esModule: true,
  hasDuplicates: () => false,
  containsGibberish: () => false,
  containsProfanity: () => false,
  isProfanityFree: () => true,
  isMeaningfulText: () => true,
  validateSensibleContent: () => true,
  cleanProfanity: (text: string) => text,
}));

import {
  OFFERING_ADAPTERS,
  duplicateFormValues,
} from "@/components/offerings/editor/adapters";

describe("webinar adapter topic mapping", () => {
  it("maps mixed Topic-relation objects and plain strings to names", () => {
    const plan = OFFERING_ADAPTERS.webinar.planOf({
      webinarPlan: {
        price: 100000,
        topics: [{ id: "t1", name: "System Design" }, "Behavioural Interviews"],
      },
    });

    expect(plan?.topics).toEqual(["System Design", "Behavioural Interviews"]);
    expect(plan?.price).toBe(1000);
  });

  it("yields an empty array when topics is missing or empty", () => {
    expect(
      OFFERING_ADAPTERS.webinar.planOf({ webinarPlan: { price: 0 } })?.topics,
    ).toEqual([]);
    expect(
      OFFERING_ADAPTERS.webinar.planOf({
        webinarPlan: { price: 0, topics: [] },
      })?.topics,
    ).toEqual([]);
  });
});

// #1527 QA D5 — Duplicate (`new?from=`) must carry topics like every other
// list field; the 1:1 GET answers them as names.
describe("duplicate prefill", () => {
  it("keeps topics and content, drops ids and the schedule", () => {
    const source = OFFERING_ADAPTERS.consultation.planOf({
      consultationPlan: {
        id: "p1",
        status: "PUBLISHED",
        title: "Basic Consultation",
        price: 50000,
        topics: ["Career growth"],
        faqs: [{ id: "f1", question: "Q", answer: "A" }],
      },
    });
    const copy = duplicateFormValues(source ?? {});
    expect(copy).toMatchObject({
      title: "Copy of Basic Consultation",
      topics: ["Career growth"],
      faqs: [{ question: "Q", answer: "A" }],
    });
    expect(copy).not.toHaveProperty("id");
    expect(copy).not.toHaveProperty("status");
  });
});
