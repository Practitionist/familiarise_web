/**
 * @jest-environment node
 */

/**
 * #1554 — the terminology guard fails a tree that reintroduces a retired
 * scheduling name and passes a clean one. Runs the guard's own scanner over
 * throwaway fixture trees, so it pins the script rather than a copy of its
 * list.
 */

import fs from "fs";
import os from "os";
import path from "path";

import { scanTrees } from "../../scripts/ci/check-terminology";

function fixtureRoot(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "terminology-"));
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return root;
}

describe("check-terminology", () => {
  it("passes a clean fixture tree", () => {
    const root = fixtureRoot({
      "lib/clean.ts":
        "const rows = await prisma.appointmentOccurrence.findMany();\nconst s = session.user.id; // Better Auth stays\n",
    });
    expect(scanTrees(["lib"], root)).toEqual([]);
  });

  it("fails a fixture that reaches for the retired delegate", () => {
    const root = fixtureRoot({
      "lib/stale.ts":
        "const rows = await prisma.slotOfAppointment.findMany();\n",
    });
    expect(scanTrees(["lib"], root)).toEqual([
      { file: "lib/stale.ts", line: 1, match: "slotOfAppointment" },
    ]);
  });

  it("refuses the retired Class names as whole identifiers only (#1640)", () => {
    const root = fixtureRoot({
      "lib/stale.ts":
        'const c = await prisma.class.findFirst({ where: { classId } });\nconst el = <div className="class card" />;\n',
      "lib/fine.ts":
        'const rows = await prisma.cohort.findMany({ where: { cohortPlanId } });\nconst el = <div className="class card" />;\n',
    });
    expect(scanTrees(["lib"], root)).toEqual([
      { file: "lib/stale.ts", line: 1, match: "classId" },
      { file: "lib/stale.ts", line: 1, match: "prisma.class." },
    ]);
  });
});
