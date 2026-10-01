/**
 * @jest-environment node
 */

/** #1746 — the HTTP twin runs the failed-refund notify pass, like the Actions job. */

const reconcilePendingRefunds = jest.fn();
const notifyFailedRefunds = jest.fn();
let captured: { run: (req: unknown) => Promise<Record<string, unknown>> };

jest.mock("../../scripts/refunds/reconcile-pending-refunds", () => ({
  reconcilePendingRefunds: (...a: unknown[]) => reconcilePendingRefunds(...a),
  notifyFailedRefunds: () => notifyFailedRefunds(),
}));
jest.mock("../../lib/cron/cleanup-route", () => ({
  cleanupRoute: (cfg: typeof captured) => {
    captured = cfg;
    return { GET: jest.fn(), POST: jest.fn() };
  },
  parseLimitParam: () => 50,
  statusFor: jest.fn(),
}));

beforeAll(() => {
  // Required here, not imported: an import is hoisted above `captured`.
  require("../../app/api/cleanup/reconcile-refunds/route");
});

it("reconciles first, then notifies payers of FAILED refunds", async () => {
  const order: string[] = [];
  reconcilePendingRefunds.mockImplementation(async () => {
    order.push("reconcile");
    return { success: true, totalProcessed: 1 };
  });
  notifyFailedRefunds.mockImplementation(async () => {
    order.push("notify");
    return { scanned: 2, notified: 2 };
  });

  const result = await captured.run({});

  expect(order).toEqual(["reconcile", "notify"]);
  expect(reconcilePendingRefunds).toHaveBeenCalledWith({ limit: 50 });
  expect(result).toMatchObject({ success: true, failedNotified: 2 });
});
