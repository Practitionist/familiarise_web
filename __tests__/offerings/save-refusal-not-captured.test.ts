/**
 * @jest-environment node
 */

/**
 * A 4xx from an offering save reaches the editor as an ApiResponseError, so the
 * editor's Sentry gate (`isExpectedRefusal`) skips it and a 422 PLAN_NOT_FEASIBLE
 * shows its reasons; a 5xx still reads as a fault.
 */
jest.mock("../../utils/contentValidation", () => ({
  __esModule: true,
  validateTitle: () => true,
  validateDescription: () => true,
  containsProfanity: () => false,
  containsGibberish: () => false,
}));

import { WebinarService } from "@/components/planner/services/events/webinar-service";
import { ClassService } from "@/components/planner/services/events/class-service";
import {
  DIGITAL_PRODUCT_DEFAULTS,
  saveDigitalProduct,
} from "@/components/offerings/editor/adapters";
import { feasibilityRefusalOf } from "@/components/offerings/editor/feasibility-feedback";
import { isExpectedRefusal } from "@/lib/errors/client-refusal";

const answer = (status: number, body: unknown) =>
  jest
    .spyOn(global, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );

const saves = {
  webinar: () => WebinarService.saveWebinar({}, null, "cp-1"),
  class: () => ClassService.saveClass({}, "cp-1"),
  "digital product": () =>
    saveDigitalProduct({ ...DIGITAL_PRODUCT_DEFAULTS, title: "Guide" }),
};

beforeEach(() => jest.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

describe.each(Object.entries(saves))("saving a %s", (_kind, save) => {
  it.each([403, 422])("treats a %i as the server's answer", async (status) => {
    answer(status, { error: "Not allowed", code: "FORBIDDEN" });
    const error = await save().catch((e: unknown) => e);
    expect(isExpectedRefusal(error)).toBe(true);
    expect(error).toMatchObject({ status, message: "Not allowed" });
  });

  it("still treats a 500 as a fault", async () => {
    answer(500, { error: "boom" });
    expect(isExpectedRefusal(await save().catch((e: unknown) => e))).toBe(
      false,
    );
  });
});

it("hands a webinar's PLAN_NOT_FEASIBLE reasons to the editor", async () => {
  answer(422, {
    error: "Not feasible",
    code: "PLAN_NOT_FEASIBLE",
    reasons: [{ message: "No open hours that week" }],
  });
  const error = await WebinarService.saveWebinar({}, null, "cp-1").catch(
    (e: unknown) => e,
  );
  expect(feasibilityRefusalOf(error)).toEqual(["No open hours that week"]);
});
