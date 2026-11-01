/** @jest-environment node */
import { NextResponse, type NextRequest } from "next/server";
import type { AdminRunRequest } from "@prisma/client";

const mockDb = {
  adminRunRequest: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
  },
  systemJobExecution: { findFirst: jest.fn() },
};
const mockInvoke = jest.fn();

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockDb;
  },
}));
jest.mock("@/lib/cron/cleanup-registry", () => ({
  getCleanupJobHandlers: () => ({ invoke: mockInvoke }),
}));
jest.mock("@/lib/cron/with-cron-lock", () => ({
  withCronLock: (_job: string, _opts: unknown, fn: () => unknown) => fn(),
}));

import { currentRun } from "@/lib/cron/run-context";
import {
  adminRunBacklogWhere,
  drainAdminRunRequests,
  hasAdminRunRequestWork,
  runAdminRunRequest,
} from "@/lib/cron/admin-run-requests";
import type { Tx } from "@/lib/prisma";

const WINDOW = new Date("2026-10-26T20:00:00.000Z");

function request(overrides: Partial<AdminRunRequest> = {}): AdminRunRequest {
  return {
    id: "req-1",
    job: "create-payout-batch",
    status: "REQUESTED",
    requestedBy: "admin-1",
    attempts: 0,
    lastError: null,
    windowStart: WINDOW,
    createdAt: new Date(),
    updatedAt: new Date(),
    claimedAt: null,
    finishedAt: null,
    runId: null,
    ...overrides,
  };
}

function outcome(runOutcome: string, status = 200) {
  return NextResponse.json(
    {},
    { status, headers: { "X-Run-Outcome": runOutcome } },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.adminRunRequest.updateMany.mockResolvedValue({ count: 1 });
  mockDb.systemJobExecution.findFirst.mockResolvedValue(null);
});

it("answers idle with no backlog and has-work without querying once out of time", async () => {
  const db = mockDb as unknown as Tx;
  mockDb.adminRunRequest.findFirst.mockResolvedValueOnce(null);
  await expect(
    hasAdminRunRequestWork(db, new Date(), () => false),
  ).resolves.toBe(false);
  await expect(
    hasAdminRunRequestWork(db, new Date(), () => true),
  ).resolves.toBe(true);
  expect(mockDb.adminRunRequest.findFirst).toHaveBeenCalledTimes(1);
});

it("claims by CAS, runs as the admin with the admitted window and links the run row", async () => {
  let seen: { triggeredBy?: string; opsActionLogId?: string } = {};
  mockInvoke.mockImplementationOnce(async (req: NextRequest) => {
    seen = { ...currentRun() };
    expect(req.nextUrl.searchParams.get("windowStart")).toBe(
      WINDOW.toISOString(),
    );
    return outcome("completed");
  });
  mockDb.systemJobExecution.findFirst.mockResolvedValueOnce({
    id: "run-1",
    result: { outcome: "completed", opsActionLogId: "req-1" },
  });
  await expect(runAdminRunRequest(request())).resolves.toBe("DONE");
  expect(mockDb.adminRunRequest.updateMany).toHaveBeenNthCalledWith(1, {
    where: { AND: [{ id: "req-1", status: "REQUESTED", attempts: 0 }, {}] },
    data: expect.objectContaining({ status: "CLAIMED", attempts: 1 }),
  });
  expect(seen).toMatchObject({
    triggeredBy: "admin:admin-1",
    opsActionLogId: "req-1",
  });
  expect(mockDb.adminRunRequest.updateMany).toHaveBeenLastCalledWith({
    where: { id: "req-1", status: "CLAIMED", attempts: 1 },
    data: expect.objectContaining({ status: "DONE", runId: "run-1" }),
  });
});

it.each([
  [
    "a failed run settles FAILED",
    () => outcome("failed", 500),
    "FAILED",
    "FAILED",
  ],
  [
    "a stand-down goes back to REQUESTED",
    () => outcome("held", 409),
    "REQUESTED",
    "RELEASED",
  ],
  [
    "a thrown dispatch goes back to REQUESTED",
    () => Promise.reject(new Error("boom")),
    "REQUESTED",
    "RELEASED",
  ],
])("%s", async (_name, respond, status, settled) => {
  mockInvoke.mockImplementationOnce(respond);
  await expect(runAdminRunRequest(request())).resolves.toBe(settled);
  expect(mockDb.adminRunRequest.updateMany).toHaveBeenLastCalledWith({
    where: { id: "req-1", status: "CLAIMED", attempts: 1 },
    data: expect.objectContaining({ status }),
  });
});

it("never runs a request whose claim another worker won", async () => {
  mockDb.adminRunRequest.updateMany.mockResolvedValueOnce({ count: 0 });
  await expect(runAdminRunRequest(request())).resolves.toBe("LOST_CLAIM");
  expect(mockInvoke).not.toHaveBeenCalled();
});

it("drains a lost dispatch, settles a finished stale claim from its run and fails a spent one", async () => {
  const stale = new Date(Date.now() - 60 * 60_000);
  mockDb.adminRunRequest.findMany.mockResolvedValueOnce([
    request({ id: "lost", updatedAt: stale }),
    request({ id: "ran", status: "CLAIMED", attempts: 1, claimedAt: stale }),
    request({ id: "spent", status: "CLAIMED", attempts: 3, claimedAt: stale }),
  ]);
  mockInvoke.mockResolvedValueOnce(outcome("completed"));
  mockDb.systemJobExecution.findFirst
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ id: "run-2", result: { outcome: "partial" } })
    .mockResolvedValueOnce(null);

  const result = await drainAdminRunRequests({ limit: 3 });

  expect(result).toMatchObject({
    picked: 3,
    done: 2,
    settledFailed: 1,
    lost: 0,
  });
  expect(mockInvoke).toHaveBeenCalledTimes(1);
  const writes = mockDb.adminRunRequest.updateMany.mock.calls.map(
    ([arg]) => arg,
  );
  // The claim repeats the backlog predicate, so a concurrent dispatch that claimed first wins.
  expect(Object.keys(writes[0].where.AND[1])).toEqual(
    Object.keys(adminRunBacklogWhere(new Date())),
  );
  expect(writes).toContainEqual({
    where: { id: "ran", status: "CLAIMED", attempts: 1 },
    data: expect.objectContaining({ status: "DONE", runId: "run-2" }),
  });
  expect(writes).toContainEqual({
    where: {
      AND: [{ id: "spent", status: "CLAIMED", attempts: 3 }, expect.anything()],
    },
    data: expect.objectContaining({ status: "FAILED" }),
  });
});
