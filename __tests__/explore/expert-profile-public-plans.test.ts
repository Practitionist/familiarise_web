/**
 * @jest-environment node
 */
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(
  path.resolve(__dirname, "../../lib/data/consultant-detail.ts"),
  "utf8",
);

describe("the expert profile's public plan read", () => {
  it("lists only discoverable webinars and classes, with each class's next batch", () => {
    expect(source).toContain(
      "webinarPlans: { where: eventPlanDiscoverableWhere() }",
    );
    expect(source).toMatch(
      /classPlans: \{\s*where: eventPlanDiscoverableWhere\(\),[\s\S]*?schedulingPeriodStartsAt: \{ gt: new Date\(\) \}/,
    );
  });

  it("never reads reliability strikes", () => {
    expect(source).not.toMatch(/strike|reliability/i);
  });
});
