/**
 * @jest-environment node
 */

// Reads re-arm the Redis keys only from the open DB window, capped at its planned end plus grace.

const pexpire = jest.fn(async (..._a: unknown[]) => 1);
const get = jest.fn();
jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: {
    get: (...a: unknown[]) => get(...a),
    pexpire: (...a: unknown[]) => pexpire(...a),
  },
  withCircuitBreaker: (fn: () => Promise<unknown>) => fn(),
}));

const findFirst = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    maintenanceWindow: {
      findFirst: (...a: unknown[]) => findFirst(...a),
    },
  },
}));

import { getMaintenanceState } from "../../lib/maintenance";

const NOW = Date.parse("2026-10-04T10:00:00Z");
const HOUR_MS = 60 * 60 * 1000;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, "now").mockReturnValue(NOW);
  get.mockImplementation(async (key: string) =>
    key.endsWith("phase") ? "OFFLINE" : null,
  );
});

afterEach(() => jest.restoreAllMocks());

describe("maintenance key TTL refresh", () => {
  it("caps the refreshed TTL at the planned end plus one hour of grace", async () => {
    findFirst.mockResolvedValue({ estimatedEnd: new Date(NOW + 2 * HOUR_MS) });
    const state = await getMaintenanceState();
    expect(state.phase).toBe("OFFLINE");
    expect(findFirst.mock.calls[0][0].where).toMatchObject({
      organizationId: null,
    });
    expect(pexpire).toHaveBeenCalledTimes(2);
    for (const call of pexpire.mock.calls as unknown as [string, number][]) {
      expect(call[1]).toBe(3 * HOUR_MS);
    }
  });

  it("never exceeds 24 h for a long planned window", async () => {
    findFirst.mockResolvedValue({
      estimatedEnd: new Date(NOW + 72 * HOUR_MS),
    });
    await getMaintenanceState();
    for (const call of pexpire.mock.calls as unknown as [string, number][]) {
      expect(call[1]).toBe(24 * HOUR_MS);
    }
  });

  it("stops refreshing once the planned end plus grace has passed, or with no open row", async () => {
    findFirst.mockResolvedValueOnce({
      estimatedEnd: new Date(NOW - 2 * HOUR_MS),
    });
    await getMaintenanceState();
    findFirst.mockResolvedValueOnce(null);
    await getMaintenanceState();
    expect(pexpire).not.toHaveBeenCalled();
  });

  it("a failed DB read keeps the active phase", async () => {
    findFirst.mockRejectedValue(new Error("db down"));
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const state = await getMaintenanceState();
    expect(state.phase).toBe("OFFLINE");
    expect(pexpire).not.toHaveBeenCalled();
  });
});
