/**
 * @jest-environment node
 */
/**
 * The final-submit refusal is routed to the step that owns the first failing
 * field and named in the customer's words; a typed server refusal carries
 * its code and field through `refusalResult`.
 */
import {
  describeIssuePath,
  stepKeyForField,
  summarizeIssues,
} from "../../app/form/onboarding/field-map";
import {
  OnboardingRefusedError,
  refusalFromIssues,
  refusalResult,
} from "../../utils/onboarding-shared";

describe("field-map", () => {
  it("names a nested path by its field label and row", () => {
    expect(describeIssuePath(["weeklySlots", 2, "endTime"])).toBe(
      "Weekly hours (row 3)",
    );
    expect(describeIssuePath(["description"])).toBe("About your expertise");
    expect(describeIssuePath(["unknownKey"])).toBe("A field");
  });

  it("groups issues by owning step in step order, first group first", () => {
    const groups = summarizeIssues(
      [
        { path: ["verificationLinkedinUrl"], message: "Invalid url" },
        { path: ["weeklySlots", 0, "startTime"], message: "Required" },
        { path: ["weeklySlots", 1, "startTime"], message: "Required" },
        { path: ["name"], message: "Required" },
      ],
      ["personal", "professional", "availability", "agreement", "review"],
    );
    expect(groups.map((g) => g.stepKey)).toEqual([
      "personal",
      "availability",
      "agreement",
    ]);
    expect(groups[1].lines).toEqual([
      "Weekly hours (row 1): Required",
      "Weekly hours (row 2): Required",
    ]);
  });

  it("every consultant payload field the wizard collects has an owning step", () => {
    for (const field of [
      "name",
      "description",
      "domain",
      "tags",
      "workExperiences",
      "scheduleType",
      "weeklySlots",
      "customSlots",
      "termsAccepted",
      "verificationDocuments",
    ]) {
      expect(stepKeyForField(field)).not.toBeNull();
    }
  });

  it("a server-schema issue is routed to the wizard field by its nested path", () => {
    const refusal = refusalFromIssues(
      [
        {
          path: ["consultantProfile", "create", "availabilityWindowsWeekly"],
          message:
            "Add at least one availability window for the chosen schedule",
        },
      ],
      "Invalid input",
    );
    expect(refusal.field).toBe("weeklySlots");
    expect(refusal.message).toMatch(/at least one availability window/);
    expect(
      refusalFromIssues([{ path: ["nope"], message: "x" }], "fb").field,
    ).toBeUndefined();
  });

  it("a typed refusal keeps its code, field and index; an untyped error never reaches the customer", () => {
    expect(
      refusalResult(
        new OnboardingRefusedError("DURATION", "Too short", "weeklySlots", 1),
        "fallback",
      ),
    ).toEqual({
      success: false,
      error: "Too short",
      code: "DURATION",
      field: "weeklySlots",
      index: 1,
    });
    expect(
      refusalResult(new Error("P2002 on users_phone_key"), "fallback"),
    ).toEqual({
      success: false,
      error: "fallback",
    });
    expect(refusalResult("junk", "fallback")).toEqual({
      success: false,
      error: "fallback",
    });
  });
});
