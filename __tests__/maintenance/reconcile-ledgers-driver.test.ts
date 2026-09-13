/**
 * @jest-environment node
 */

/**
 * #1454 — the background driver's loop must stop on the twin's terminal
 * answer and never outrun its own budget. The twin is a mocked `fetch` that
 * answers RUNNING twice and COMPLETED on the third call; the loop must make
 * exactly three calls, wait for nothing, and stay inside the budget. A second
 * case pins the budget guard so a twin that never completes cannot pin the
 * function to its 15-minute ceiling.
 */

import { driveReconcileRun } from "../../lib/reconcile/drive-reconcile-run";

function twin(statuses: Array<"RUNNING" | "COMPLETED">) {
  const calls: string[] = [];
  const fetchImpl = jest.fn(async (url: string, _init?: RequestInit) => {
    calls.push(url);
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    return new Response(JSON.stringify({ status }), { status: 200 });
  });
  return { calls, fetchImpl };
}

const base = {
  sleep: jest.fn(async () => {}),
  baseUrl: "https://site.test",
  secret: "s3cret",
  runId: "11111111-1111-4111-8111-111111111111",
  limit: 100,
  triggeredById: "admin_1",
  budgetMs: 60_000,
  maxCalls: 50,
  perCallTimeoutMs: 1_000,
  maxConsecutiveRetries: 3,
  retryDelayMs: 1,
};

describe("driveReconcileRun", () => {
  it("calls the twin until it reports COMPLETED and then stops", async () => {
    const { calls, fetchImpl } = twin(["RUNNING", "RUNNING", "COMPLETED"]);

    const result = await driveReconcileRun({ ...base, fetchImpl });

    expect(calls).toHaveLength(3);
    expect(calls[0]).toBe(
      `https://site.test/api/cleanup/reconcile-ledgers?runId=${base.runId}&limit=100&triggeredById=admin_1`,
    );
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer s3cret" },
    });
    expect(result).toMatchObject({
      outcome: "COMPLETED",
      calls: 3,
      retried: 0,
      lastStatus: 200,
    });
    expect(base.sleep).not.toHaveBeenCalled();
  });

  it("gives up at its own budget when the twin never completes", async () => {
    const { calls, fetchImpl } = twin(["RUNNING"]);
    let clock = 0;
    // Every call costs 10 s of fake time against a 25 s budget.
    const now = () => {
      clock += 10_000;
      return clock;
    };

    const result = await driveReconcileRun({
      ...base,
      fetchImpl,
      budgetMs: 25_000,
      now,
    });

    expect(result.outcome).toBe("BUDGET_EXHAUSTED");
    expect(calls.length).toBeLessThan(base.maxCalls);
    expect(calls.length).toBeGreaterThan(0);
  });
});
