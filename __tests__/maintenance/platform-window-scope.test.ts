/**
 * @jest-environment node
 */

/**
 * #1598 P1-W01 — `setMaintenanceState` reads the "active window" without an
 * org scope, so `OFF` closed a tenant's per-org row and an OFFLINE call
 * re-labelled it as platform-wide. The pin: the platform read filters on
 * `organizationId: null`, so an active per-org row is never the match.
 */

jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: { set: jest.fn(async () => "OK") },
  withCircuitBreaker: jest.fn(),
}));

const findFirst = jest.fn();
const update = jest.fn();
const create = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({ maintenanceWindow: { findFirst, update, create } }),
  },
}));

import { MaintenancePhase } from "@prisma/client";

import { setMaintenanceState } from "../../lib/maintenance";

// A tiny table: one active per-org row, no platform row.
const rows = [{ id: "win_org", phase: "DEGRADED", organizationId: "org_1" }];

beforeEach(() => {
  jest.clearAllMocks();
  findFirst.mockImplementation(async ({ where }) => {
    const orgFilter = "organizationId" in where ? where.organizationId : "*";
    return (
      rows.find(
        (r) =>
          r.phase !== "OFF" &&
          (orgFilter === "*" || r.organizationId === orgFilter),
      ) ?? null
    );
  });
});

describe("setMaintenanceState platform scope (#1598 P1-W01)", () => {
  it("OFF does not close an active per-org window", async () => {
    await setMaintenanceState(MaintenancePhase.OFF, { endedBy: "ops" });
    expect(findFirst.mock.calls[0][0].where).toMatchObject({
      organizationId: null,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("OFFLINE creates a platform row instead of re-labelling the org's", async () => {
    await setMaintenanceState(MaintenancePhase.OFFLINE, { reason: "deploy" });
    expect(update).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
