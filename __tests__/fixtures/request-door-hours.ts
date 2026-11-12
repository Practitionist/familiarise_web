/** Stands in for lib/booking/allocation/coverage: the picked time is inside the published hours. */
export const assertSlotsStillPublished = jest.fn(async () => undefined);

/** The named weekly window the request door looks up, found on the consultant. */
export const namedWeeklyWindow = {
  findFirst: jest.fn(async () => ({ id: "aw_1" })),
};
