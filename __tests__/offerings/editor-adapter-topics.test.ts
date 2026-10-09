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

import { zodResolver } from "@hookform/resolvers/zod";
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

// The resolver hands onValid the parsed output, so a stripped `id` turns every
// webinar/class edit into a create.
describe("edit save keeps the plan id", () => {
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  future.setUTCMinutes(0, 0, 0);
  const shared = {
    id: "plan-1",
    title: "Existing Offering",
    description: "A long enough description for the plan schema.",
    price: 50000,
    topics: ["System design"],
    learningOutcomes: ["Ship it"],
  };
  const cases = [
    {
      type: "webinar" as const,
      event: {
        id: "web-1",
        instanceId: "web-1",
        instanceStatus: "SCHEDULED",
        webinarPlan: { ...shared, scheduledAt: future.toISOString() },
      },
      endpoint: "/api/bookings/webinars/crud-with-plan",
      instanceKey: "webinarId",
      instanceId: "web-1",
    },
    {
      type: "class" as const,
      event: {
        id: "cls-1",
        instanceId: "cls-1",
        instanceStatus: "SCHEDULED",
        classPlan: {
          ...shared,
          classContents: [
            { title: "Week one", description: "Warm up", hoursAllotted: 1 },
          ],
        },
      },
      endpoint: "/api/bookings/classes/crud-with-plan",
      instanceKey: "classId",
      instanceId: "cls-1",
    },
  ];

  it.each(cases)(
    "$type resolves with the id and saves with PATCH",
    async ({ type, event, endpoint, instanceKey, instanceId }) => {
      const adapter = OFFERING_ADAPTERS[type];
      const resolved = await zodResolver(adapter.schema)(
        { ...adapter.defaults, ...adapter.planOf(event) },
        undefined,
        { fields: {}, shouldUseNativeValidation: false },
      );
      expect(resolved.errors).toEqual({});
      expect(resolved.values).toMatchObject({ id: "plan-1" });

      const fetchMock = jest.fn(async (url: string) => ({
        ok: true,
        json: async () =>
          url.includes("check-duplicate-title")
            ? { isDuplicate: false }
            : { data: { id: instanceId } },
      }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await adapter.save(resolved.values, "cp-1", event);

      const [checkUrl] = fetchMock.mock.calls[0] as unknown as [string];
      expect(checkUrl).toContain("excludeId=plan-1");
      const [url, init] = fetchMock.mock.calls[1] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe(endpoint);
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(String(init.body))).toMatchObject({
        id: "plan-1",
        [instanceKey]: instanceId,
      });
    },
  );
});
