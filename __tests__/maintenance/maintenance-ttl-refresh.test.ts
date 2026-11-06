/** @jest-environment node */
jest.mock("../../lib/novu/service", () => ({
  stageMaintenanceBells: jest.fn(),
}));
const findFirst = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    maintenanceWindow: {
      findFirst: (...args: unknown[]) => findFirst(...args),
    },
  },
}));
jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));
jest.mock("../../lib/backoffice/ops-action-log", () => ({
  recordOpsAction: jest.fn(),
}));
import { getMaintenanceState } from "../../lib/maintenance";

it("keeps overdue maintenance active until explicitly ended", async () => {
  findFirst.mockResolvedValue({
    phase: "OFFLINE",
    reason: "migration",
    estimatedEnd: new Date("2020-01-01"),
    bypassSecret: "key",
    betterstackIncidentId: null,
  });
  expect((await getMaintenanceState()).phase).toBe("OFFLINE");
});
it("does not represent a database outage as OFF", async () => {
  findFirst.mockRejectedValue(new Error("unreadable"));
  await expect(getMaintenanceState()).rejects.toThrow("unreadable");
});
