/** @jest-environment node */
const get = jest.fn();
const set = jest.fn();
const del = jest.fn();
const findMany = jest.fn();
const updateMany = jest.fn(async (..._args: unknown[]) => ({ count: 1 }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    discountCode: {
      findMany: (...args: unknown[]) => findMany(...args),
      updateMany: (...args: unknown[]) => updateMany(...args),
    },
  },
}));
jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: {
    get: (...args: unknown[]) => get(...args),
    set: (...args: unknown[]) => set(...args),
    del: (...args: unknown[]) => del(...args),
  },
}));
import {
  pauseDiscountCodes,
  restoreDiscountCodes,
} from "../../actions/maintenance/pause-discount-codes";

beforeEach(() => jest.clearAllMocks());
it("preserves the first snapshot through concurrent repeated pauses", async () => {
  let snapshot: string | null = null;
  set.mockImplementation(
    async (_key: string, value: string, options: { nx: boolean }) => {
      if (options.nx && snapshot !== null) return null;
      snapshot = value;
      return "OK";
    },
  );
  get.mockImplementation(async () => snapshot);
  findMany
    .mockResolvedValueOnce([{ id: "original" }])
    .mockResolvedValueOnce([{ id: "new-code" }]);
  await Promise.all([pauseDiscountCodes(), pauseDiscountCodes()]);
  expect(snapshot).toBe('["original"]');
  for (const [args] of updateMany.mock.calls)
    expect(args).toMatchObject({ where: { id: { in: ["original"] } } });
});
it("retains corrupt snapshots and refuses restoration", async () => {
  get.mockResolvedValue('{"not":"ids"}');
  await expect(restoreDiscountCodes()).rejects.toThrow();
  expect(updateMany).not.toHaveBeenCalled();
  expect(del).not.toHaveBeenCalled();
});
it("retains the snapshot when a database restore fails", async () => {
  get.mockResolvedValue('["original"]');
  findMany.mockResolvedValue([]);
  updateMany.mockRejectedValueOnce(new Error("database unavailable"));
  await expect(restoreDiscountCodes()).rejects.toThrow("database unavailable");
  expect(del).not.toHaveBeenCalled();
});
