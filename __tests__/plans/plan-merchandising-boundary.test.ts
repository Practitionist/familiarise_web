/**
 * @jest-environment node
 */

/**
 * `sortOrder` and `isFeatured` are optional in the boundary schema with NO
 * default, deliberately.
 *
 * The authoring editors do not all render these fields, and the four plan
 * services build explicit payload objects. A `.default(0)` here would be filled
 * in by `safeParse` on every PUT, so saving a plan to change its price would
 * silently reset the expert's storefront position and strip their Popular
 * badge. `offeringPlanStatusSchema` is optional for the same reason.
 *
 * The columns carry `@default(0)` / `@default(false)` in the schema, so an
 * absent value still creates a correctly-initialised plan.
 */

// schemas/plans pulls `bad-words` (ESM-only) in through utils/contentValidation
// at import time (see __tests__/plans/plan-archive-toggle.test.ts). The profanity
// and gibberish refinements are not what this file pins, so boundary-mock the
// module rather than transform node_modules.
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

import { ConsultationPlanSchema, WebinarPlanSchema } from "@/schemas/plans";
import { merchandisingPayload } from "@/components/planner/services/shared/plan-payload";

const consultationBase = {
  title: "Mock interview",
  description: "A realistic interview with written feedback.",
  durationInHours: 1,
  price: 100000,
  language: "English",
  level: "BEGINNER",
  prerequisites: "",
  materialProvided: "",
  learningOutcomes: ["Written feedback after the call"],
  topics: ["Interviews"],
};

/** The next :00 or :30 boundary, which is what WebinarPlanSchema accepts. */
function nextHalfHourIso(): string {
  const d = new Date(Date.now() + 86_400_000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 0, 0, 0);
  if (d.getMinutes() === 0 && d.getTime() < Date.now() + 86_400_000) {
    d.setHours(d.getHours() + 1);
  }
  return d.toISOString();
}

describe("plan merchandising boundary", () => {
  it("leaves the storefront fields undefined when the editor sends neither", () => {
    const parsed = ConsultationPlanSchema.parse(consultationBase);

    expect(parsed.sortOrder).toBeUndefined();
    expect(parsed.isFeatured).toBeUndefined();
  });

  it("accepts an explicit position and badge", () => {
    const parsed = ConsultationPlanSchema.parse({
      ...consultationBase,
      sortOrder: 3,
      isFeatured: true,
    });

    expect(parsed.sortOrder).toBe(3);
    expect(parsed.isFeatured).toBe(true);
  });

  it("rejects a negative or fractional position", () => {
    expect(() =>
      ConsultationPlanSchema.parse({ ...consultationBase, sortOrder: -1 }),
    ).toThrow();
    expect(() =>
      ConsultationPlanSchema.parse({ ...consultationBase, sortOrder: 1.5 }),
    ).toThrow();
  });

  it("rejects a position beyond the authoring bound", () => {
    expect(() =>
      ConsultationPlanSchema.parse({ ...consultationBase, sortOrder: 1000 }),
    ).toThrow();
  });

  it("accepts a featured badge with no position set", () => {
    const parsed = ConsultationPlanSchema.parse({
      ...consultationBase,
      isFeatured: false,
    });

    expect(parsed.isFeatured).toBe(false);
    expect(parsed.sortOrder).toBeUndefined();
  });

  it("applies the same contract to event plans", () => {
    const webinar = {
      ...consultationBase,
      maxParticipants: 50,
      scheduledAt: nextHalfHourIso(),
    };

    expect(WebinarPlanSchema.parse(webinar).sortOrder).toBeUndefined();
    expect(
      WebinarPlanSchema.parse({ ...webinar, sortOrder: 2 }).sortOrder,
    ).toBe(2);
  });
});

describe("merchandisingPayload", () => {
  it("omits both keys when the editor holds neither, so the row is untouched", () => {
    expect(merchandisingPayload({})).toEqual({});
    expect(merchandisingPayload()).toEqual({});
  });

  it("sends a zero position, which is a real choice and not an absence", () => {
    expect(merchandisingPayload({ sortOrder: 0, isFeatured: false })).toEqual({
      sortOrder: 0,
      isFeatured: false,
    });
  });

  it("keeps position and badge independent", () => {
    expect(merchandisingPayload({ sortOrder: 4 })).toEqual({ sortOrder: 4 });
    expect(merchandisingPayload({ isFeatured: true })).toEqual({
      isFeatured: true,
    });
  });
});
