/**
 * @jest-environment node
 */

/**
 * `setMaintenanceState` scopes its "active window" read to the platform
 * (`organizationId: null`), so an active per-org row is never the match.
 */

const recordOpsAction = jest.fn();
jest.mock("../../lib/backoffice/ops-action-log", () => ({
  recordOpsAction: (...args: unknown[]) => recordOpsAction(...args),
}));
jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: { set: jest.fn(async () => "OK") },
  withCircuitBreaker: jest.fn(),
}));

const findFirst = jest.fn();
const update = jest.fn();
const updateMany = jest.fn();
const create = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        $executeRaw: jest.fn(),
        maintenanceWindow: { findFirst, update, updateMany, create },
      }),
  },
}));

import { MaintenancePhase } from "@prisma/client";

import { setMaintenanceState } from "../../lib/maintenance";

// Maintenance state is production state; other deploys skip the write.
process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "production";

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

const actor = { userId: "ops_1", role: "ADMIN" };

describe("setMaintenanceState platform scope", () => {
  it("OFF does not close an active per-org window", async () => {
    await setMaintenanceState(MaintenancePhase.OFF, { actor });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].where).toMatchObject({
      organizationId: null,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("OFFLINE creates a platform row instead of re-labelling the org's", async () => {
    await setMaintenanceState(MaintenancePhase.OFFLINE, {
      actor,
      reason: "deploy",
    });
    expect(update).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("audits the transition as the session's actor and role", async () => {
    create.mockResolvedValue({ id: "win_platform" });
    await setMaintenanceState(MaintenancePhase.DEGRADED, {
      actor: { userId: "ops_2", role: "STAFF" },
      reason: "Planned upgrade",
    });
    expect(create.mock.calls[0][0].data.startedBy).toBe("ops_2");
    expect(recordOpsAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorUserId: "ops_2",
        actorRole: "STAFF",
        action: "maintenance.transition",
        targetId: "win_platform",
      }),
    );
  });
});
