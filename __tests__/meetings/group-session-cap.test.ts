/**
 * @jest-environment node
 */

// schemas/plans loads `bad-words` (ESM-only) through utils/contentValidation.
jest.mock("../../utils/contentValidation", () => ({
  __esModule: true,
  hasDuplicates: () => false,
  isProfanityFree: () => true,
  isMeaningfulText: () => true,
}));

import {
  ClassPlanSchema,
  WebinarPlanSchema,
  maxParticipantsSchema,
} from "../../schemas/plans";
import { MAX_GROUP_SESSION_PARTICIPANTS } from "../../lib/events/capacity";

describe("group session participant cap", () => {
  it("refuses a plan capacity above 200 and accepts 200", () => {
    expect(MAX_GROUP_SESSION_PARTICIPANTS).toBe(200);
    expect(maxParticipantsSchema.safeParse(201).success).toBe(false);
    expect(maxParticipantsSchema.safeParse(200).success).toBe(true);
    expect(WebinarPlanSchema.shape.maxParticipants.safeParse(201).success).toBe(
      false,
    );
    expect(ClassPlanSchema.shape.maxParticipants.safeParse(201).success).toBe(
      false,
    );
  });
});
