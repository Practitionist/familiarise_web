/**
 * @jest-environment node
 */

/** A refused cover-image commit carries its status, so a 4xx is not reported as a fault and a 5xx is. */

import { commitPlanImage } from "@/components/plans/PlanImageUploader";
import { ApiResponseError } from "@/lib/fetch-helpers";
import { isExpectedRefusal } from "@/lib/errors/client-refusal";

const answer = (status: number, body: unknown) =>
  jest.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;

const removeImage = () =>
  commitPlanImage("digital-products", "dp-1", { kind: "remove" });

it("a 4xx keeps the server's sentence and reads as an expected refusal", async () => {
  globalThis.fetch = answer(409, { error: "This product is archived." });
  const error = await removeImage().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiResponseError);
  expect((error as ApiResponseError).status).toBe(409);
  expect((error as Error).message).toBe("This product is archived.");
  expect(isExpectedRefusal(error)).toBe(true);
});

it("a 5xx keeps the fallback sentence and is still a fault", async () => {
  globalThis.fetch = answer(500, null);
  const error = await removeImage().catch((e: unknown) => e);
  expect((error as Error).message).toBe("Couldn't update the cover image");
  expect(isExpectedRefusal(error)).toBe(false);
});
