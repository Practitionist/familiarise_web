/**
 * @jest-environment node
 */

/**
 * #1703 D4 — the response-rate metric: of the PENDING → answered transitions
 * in the window, the share within 24 h of the request's creation row; an
 * answer with no creation row is left out of both counts; nothing measured
 * means null, never 0 %.
 */
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import {
  computeResponseRate,
  EMPTY_RESPONSE_RATE,
  RESPONSE_RATE_TARGET_MS,
} from "@/lib/booking/response-rate";

const t0 = new Date("2026-09-01T00:00:00Z");
const after = (ms: number) => new Date(t0.getTime() + ms);
const HOUR = 60 * 60 * 1000;

describe("computeResponseRate", () => {
  it("counts answers within a day of the request against all answers", () => {
    const requestedAt = new Map([
      ["r1", t0],
      ["r2", t0],
      ["r3", t0],
    ]);
    const answers = [
      { entityId: "r1", createdAt: after(2 * HOUR) },
      { entityId: "r2", createdAt: after(RESPONSE_RATE_TARGET_MS) },
      { entityId: "r3", createdAt: after(30 * HOUR) },
      // No creation row: excluded rather than counted as late.
      { entityId: "r4", createdAt: after(HOUR) },
    ];
    expect(computeResponseRate(answers, requestedAt)).toEqual({
      withinTarget: 2,
      total: 3,
      withinTargetPct: 67,
    });
  });

  it("is null, not zero, when nothing was answered", () => {
    expect(computeResponseRate([], new Map())).toEqual(EMPTY_RESPONSE_RATE);
    expect(EMPTY_RESPONSE_RATE.withinTargetPct).toBeNull();
  });
});
