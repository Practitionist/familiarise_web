/** @jest-environment node */
const findReport = jest.fn();
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async () => ({
    session: { user: { id: "admin-1" } },
  })),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    systemJobExecution: { findFirst: jest.fn(async () => null) },
    ledgerReconciliationReport: {
      findFirst: (...args: unknown[]) => findReport(...args),
    },
  },
}));
import { GET } from "../../app/api/admin/reconcile/route";
import { reconcileOverviewSchema } from "../../schemas/backoffice/reconciliation";

beforeEach(() => jest.clearAllMocks());
it.each(["RUNNING", "FAILED", "COMPLETED"])(
  "exposes %s separately from the ledger verdict",
  async (status) => {
    findReport.mockResolvedValue({
      id: "report-1",
      runAt: new Date("2026-10-23T00:00:00Z"),
      scope: "full",
      ok: false,
      summary: { status },
    });
    const response = await GET();
    const body = reconcileOverviewSchema.parse(await response.json());
    expect(body.ledgerReport).toMatchObject({ status, ok: false });
    expect(findReport).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { scope: "full" },
        select: expect.objectContaining({ summary: true }),
      }),
    );
  },
);
it("does not invent a completed verdict for a legacy report without status", async () => {
  findReport.mockResolvedValue({
    id: "old-report",
    runAt: new Date("2026-10-23T00:00:00Z"),
    scope: "full",
    ok: false,
    summary: { discrepanciesCount: 0 },
  });
  const response = await GET();
  expect(
    reconcileOverviewSchema.parse(await response.json()).ledgerReport?.status,
  ).toBe("UNKNOWN");
});
it("returns no ledger verdict when there is no report", async () => {
  findReport.mockResolvedValue(null);
  const response = await GET();
  expect(
    reconcileOverviewSchema.parse(await response.json()).ledgerReport,
  ).toBeNull();
});
