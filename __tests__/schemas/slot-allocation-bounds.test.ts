/**
 * The allocate and validate bodies take 30-minute atoms: every start on the
 * UTC half-hour lattice, and never more of them than the largest plan needs.
 */

import {
  allocationRequestSchema,
  MAX_ALLOCATION_SLOTS,
  validationRequestSchema,
} from "@/schemas/slotAllocation/validationSchemas";

const ON_GRID = "2026-12-01T10:00:00.000Z";
const HALF_PAST = "2026-12-01T10:30:00.000Z";
const QUARTER_PAST = "2026-12-01T10:15:00.000Z";

const bodies = [
  [
    "allocate",
    (slots: string[]) =>
      allocationRequestSchema.safeParse({ isAuto: false, slots }),
  ],
  [
    "validate",
    (slots: string[]) => validationRequestSchema.safeParse({ slots }),
  ],
] as const;

describe.each(bodies)("the %s body", (_, parse) => {
  it("accepts starts on the hour and the half hour", () => {
    expect(parse([ON_GRID, HALF_PAST]).success).toBe(true);
  });

  it("refuses a start at a quarter past", () => {
    const result = parse([ON_GRID, QUARTER_PAST]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ["slots", 1],
      message: "Times start on the hour or half hour",
    });
  });

  it("refuses a start with stray seconds", () => {
    expect(parse(["2026-12-01T10:00:01.000Z"]).success).toBe(false);
  });

  it("refuses more atoms than the largest plan needs", () => {
    const atoms = (count: number) =>
      Array.from({ length: count }, (_unused, i) =>
        new Date(Date.parse(ON_GRID) + i * 30 * 60_000).toISOString(),
      );
    expect(parse(atoms(MAX_ALLOCATION_SLOTS)).success).toBe(true);
    expect(parse(atoms(MAX_ALLOCATION_SLOTS + 1)).success).toBe(false);
  });
});
