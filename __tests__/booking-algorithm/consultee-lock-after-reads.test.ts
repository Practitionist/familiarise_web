/**
 * @jest-environment node
 */

/**
 * Every allocation mode takes the consultee key in the global order
 * (consultant tier → consultee → slot batch) and only after its reads and
 * validation, so the buyer's own checkout is never refused while an expert's
 * picks are being read; the in-transaction recheck reads the consultee's
 * calendar under the key, so the move widens no race.
 */
import fs from "node:fs";
import path from "node:path";

const MODES = [
  "lib/booking/allocation/modes/manual.ts",
  "lib/booking/allocation/modes/use-requested.ts",
];

describe.each(MODES)("%s", (rel) => {
  const src = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
  const at = (needle: string) => {
    const i = src.indexOf(needle);
    expect(i).toBeGreaterThan(-1);
    return i;
  };

  it("takes the consultee key once, after validation and before the slot batch", () => {
    expect(src.match(/\blockConsulteeBooking\(/g)).toHaveLength(1);
    const consultant = at("lockAutoAllocate(");
    const validated = at(".validate(");
    const consultee = at("lockConsulteeBooking(");
    const batch = at("lockPickedSlots(");
    expect(consultant).toBeLessThan(validated);
    expect(validated).toBeLessThan(consultee);
    expect(consultee).toBeLessThan(batch);
  });

  it("re-checks the consultee's calendar inside the write transaction", () => {
    const recheck = at(".revalidateConflicts(");
    expect(recheck).toBeGreaterThan(at("bookingTransaction("));
    expect(src.slice(recheck, recheck + 400)).toContain("consulteeUserId");
  });
});
