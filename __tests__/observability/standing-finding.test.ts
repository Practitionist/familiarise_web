/**
 * @jest-environment node
 */

const findMany = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { systemEvent: { findMany: (...a: unknown[]) => findMany(...a) } },
}));
const recordSystemEvent = jest.fn();
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemEvent: (...a: unknown[]) => recordSystemEvent(...a),
}));

import { reportStandingFinding } from "../../lib/observability/standing-finding";

/** Models SystemEvent: what one run records the next run reads back. */
const stored: Array<{ context: { ids: string[] } }> = [];
beforeEach(() => {
  jest.clearAllMocks();
  stored.length = 0;
  findMany.mockImplementation(async () => stored);
  recordSystemEvent.mockImplementation(
    async (e: { context: { ids: string[] } }) => {
      stored.push({ context: e.context });
    },
  );
});

const run = (ids: string[], report: jest.Mock) =>
  reportStandingFinding({ key: "k", ids, message: "m" }, report);

describe("reportStandingFinding", () => {
  it("reports the same standing set once across consecutive runs", async () => {
    const report = jest.fn();
    expect(await run(["a", "b"], report)).toBe(true);
    expect(await run(["b", "a"], report)).toBe(false);
    expect(await run(["a", "b"], report)).toBe(false);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("reports again when the set gains an id", async () => {
    const report = jest.fn();
    await run(["a", "b"], report);
    expect(await run(["a", "b", "c"], report)).toBe(true);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("stays quiet when a moving cohort only loses ids", async () => {
    const report = jest.fn();
    await run(["a", "b", "c"], report);
    expect(await run(["b", "c"], report)).toBe(false);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("reports nothing for an empty set", async () => {
    const report = jest.fn();
    expect(await run([], report)).toBe(false);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("reports when the lookup fails rather than swallowing the finding", async () => {
    const report = jest.fn();
    findMany.mockRejectedValueOnce(new Error("db down"));
    jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(await run(["a"], report)).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
  });
});
