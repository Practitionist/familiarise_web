/**
 * @jest-environment node
 */

// Invariant: the operator Appointments read keeps one read in flight on a
// one-connection pool and takes the list `total` from the matching tab count.

let inFlight = 0;
let peak = 0;
/** Every mocked read takes a tick and records how many overlap. */
function slow<A, R>(fn: (args: A) => R) {
  return jest.fn(async (args: A) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return fn(args);
  });
}

let countCalls = 0;
const mockFindMany = slow((_args: { where: unknown }): unknown[] => []);
// Each count answers a distinct number, so `total` shows which one it came from.
const mockCount = slow((_args: { where: unknown }) => (countCalls += 1) * 10);

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: {
      findMany: (args: { where: unknown }) => mockFindMany(args),
      count: (args: { where: unknown }) => mockCount(args),
    },
    user: { findMany: async () => [] },
  },
}));

import { isDeepStrictEqual } from "node:util";
import { getStaffAppointments } from "../../lib/data/staff-appointments";

const ORIGINAL_POOL = process.env.PG_POOL_MAX;
beforeEach(() => {
  inFlight = 0;
  peak = 0;
  countCalls = 0;
  process.env.PG_POOL_MAX = "1";
});
afterAll(() => {
  process.env.PG_POOL_MAX = ORIGINAL_POOL;
});

it.each([null, "all", "scheduled", "completed", "issue"])(
  "status %s: one read in flight, one list read and four tab counts",
  async (status) => {
    const { pagination, counts } = await getStaffAppointments({
      scope: { kind: "all" },
      status,
    });
    expect(peak).toBe(1);
    expect(mockFindMany).toHaveBeenCalledTimes(1);
    expect(mockCount).toHaveBeenCalledTimes(4);
    // The tab count whose filter is exactly the list's filter supplies `total`.
    const listWhere = mockFindMany.mock.calls[0][0].where;
    const matching = mockCount.mock.calls.findIndex(([args]) =>
      isDeepStrictEqual(args.where, listWhere),
    );
    expect(matching).toBeGreaterThanOrEqual(0);
    expect(pagination.total).toBe((matching + 1) * 10);
    expect(Object.values(counts)).toContain(pagination.total);
  },
);
