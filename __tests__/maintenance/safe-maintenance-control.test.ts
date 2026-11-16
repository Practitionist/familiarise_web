/** @jest-environment node */
import { NextRequest } from "next/server";
jest.mock("../../lib/observability/throttled-capture", () => ({
  captureThrottled: jest.fn(),
}));
const getState = jest.fn();
const setState = jest.fn();
const drain = jest.fn();
const unfreeze = jest.fn();
const recovery = jest.fn();
const incident = jest.fn();
const pause = jest.fn();
const lock = jest.fn(
  (_name: string, _options: unknown, run: () => Promise<unknown>) => run(),
);
const gate = jest.fn(async (_surface: string) => ({
  session: { user: { id: "admin", role: "ADMIN" } },
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: (surface: string) => gate(surface),
}));
const audit = jest.fn();
jest.mock("../../lib/backoffice/ops-action-log", () => ({
  opsActorOf: (session: { user: { id: string; role: string } }) => ({
    userId: session.user.id,
    role: session.user.role,
  }),
  recordOpsAction: (...args: unknown[]) => audit(...args),
}));
const history = jest.fn();
const stampOffline = jest.fn();
jest.mock("../../lib/maintenance", () => ({
  getMaintenanceState: (...args: unknown[]) => getState(...args),
  setMaintenanceState: (...args: unknown[]) => setState(...args),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (name: string, options: unknown, run: () => Promise<unknown>) =>
    lock(name, options, run),
  CronLockHeldError: class extends Error {},
  CronLockUnavailableError: class extends Error {},
}));
jest.mock("../../lib/maintenance-edge", () => ({
  signMaintenanceBypassCookie: async () => "signed",
}));
jest.mock("../../lib/betterstack", () => ({
  createIncident: (...args: unknown[]) => incident(...args),
  resolveIncident: jest.fn(),
}));
jest.mock("../../lib/prisma", () => {
  const maintenanceWindow = {
    findFirstOrThrow: async () => ({ id: "window", offlineActivatedAt: null }),
    findMany: (...args: unknown[]) => history(...args),
    updateMany: (...args: unknown[]) => stampOffline(...args),
  };
  return {
    __esModule: true,
    default: {
      dispute: { findMany: async () => [] },
      maintenanceWindow,
      $transaction: (run: (tx: unknown) => Promise<unknown>) =>
        run({ maintenanceWindow }),
    },
  };
});
jest.mock("../../actions/maintenance/drain-sessions", () => ({
  drainActiveSessions: (...args: unknown[]) => drain(...args),
  unfreezeChannelsAfterMaintenance: (...args: unknown[]) => unfreeze(...args),
}));
jest.mock("../../actions/maintenance/pause-discount-codes", () => ({
  pauseDiscountCodes: (...args: unknown[]) => pause(...args),
}));
jest.mock("../../actions/maintenance/post-recovery", () => ({
  runPostRecovery: (...args: unknown[]) => recovery(...args),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  stageNowAttemptAfter: jest.fn(),
}));
import {
  GET,
  POST,
  PATCH,
  DELETE,
} from "../../app/api/admin/maintenance/route";

const request = (body: unknown) =>
  new NextRequest("http://test/api/admin/maintenance", {
    method: "POST",
    body: JSON.stringify(body),
  });
// Maintenance state is production state; other deploys skip the write.
process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "production";

beforeEach(() => {
  jest.clearAllMocks();
  getState.mockResolvedValue({
    phase: "OFF",
    reason: null,
    estimatedEnd: null,
    bypassSecret: null,
    betterstackIncidentId: null,
  });
  drain.mockResolvedValue({ errors: [] });
  unfreeze.mockResolvedValue({ errors: [] });
  recovery.mockResolvedValue({ database: true, redis: true, errors: [] });
  incident.mockResolvedValue("incident");
  pause.mockResolvedValue({ paused: 3 });
  stampOffline.mockResolvedValue({ count: 1 });
});
it("gates every verb on maintenance.manage", async () => {
  history.mockResolvedValue([]);
  await GET();
  await DELETE(request({ reason: "Recovery verified" }));
  expect(gate.mock.calls.map(([surface]) => surface)).toEqual(
    expect.arrayContaining(["maintenance.manage"]),
  );
  expect(new Set(gate.mock.calls.map(([surface]) => surface))).toEqual(
    new Set(["maintenance.manage"]),
  );
});
it("returns history without any window's bypass secret or incident id", async () => {
  const ended = {
    id: "w_old",
    phase: "OFF",
    reason: "Old window",
    bypassSecret: "old-secret",
    betterstackIncidentId: "inc_old",
    createdAt: "2026-11-01T00:00:00.000Z",
  };
  history.mockImplementation(
    async ({ select }: { select?: Record<string, true> }) => [
      select
        ? Object.fromEntries(
            Object.entries(ended).filter(([key]) => select[key]),
          )
        : ended,
    ],
  );
  getState.mockResolvedValue({
    phase: "DEGRADED",
    reason: "Upgrade",
    estimatedEnd: null,
    bypassSecret: "active-secret",
    betterstackIncidentId: null,
  });
  const body = await (await GET()).json();
  expect(body.history).toHaveLength(1);
  for (const row of body.history) {
    expect(row).not.toHaveProperty("bypassSecret");
    expect(row).not.toHaveProperty("betterstackIncidentId");
  }
  expect(body.state.bypassSecret).toBe("active-secret");
  expect(body.bypassCookieToken).toBe("signed");
});
it("rejects empty requests without changing state or calling a vendor", async () => {
  expect((await POST(request({}))).status).toBe(400);
  expect((await PATCH(request({}))).status).toBe(400);
  expect((await DELETE(request({}))).status).toBe(400);
  expect(setState).not.toHaveBeenCalled();
  expect(incident).not.toHaveBeenCalled();
  for (const result of lock.mock.results) {
    await expect(result.value).resolves.toMatchObject({ success: false });
  }
});
it("activates OFFLINE without invoking booking remediation", async () => {
  const result = await POST(
    request({ phase: "OFFLINE", reason: "Database maintenance" }),
  );
  expect(result.status).toBe(200);
  expect(setState).toHaveBeenCalledWith(
    "OFFLINE",
    expect.objectContaining({
      reason: "Database maintenance",
      actor: { userId: "admin", role: "ADMIN" },
    }),
  );
  expect(drain).toHaveBeenCalledTimes(1);
  expect(pause).toHaveBeenCalledTimes(1);
  expect(audit).toHaveBeenCalledTimes(1);
  expect(audit).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      actorUserId: "admin",
      actorRole: "ADMIN",
      action: "maintenance.offline-activated",
      targetId: "window",
      reason: "Database maintenance",
      after: expect.objectContaining({ discountCodesPaused: 3 }),
    }),
  );
  expect(await result.json()).not.toHaveProperty("freeze");
  expect(lock).toHaveBeenCalledWith(
    "maintenance-control",
    expect.objectContaining({ failMode: "closed" }),
    expect.any(Function),
  );
});
it("retries activation with the same bypass secret and no duplicate incident", async () => {
  getState.mockResolvedValue({
    phase: "OFFLINE",
    bypassSecret: "original",
    reason: "Database maintenance",
    estimatedEnd: null,
    betterstackIncidentId: "original-incident",
  });
  const result = await POST(
    request({ phase: "OFFLINE", reason: "Database maintenance" }),
  );
  expect((await result.json()).bypassSecret).toBe("original");
  expect(incident).not.toHaveBeenCalled();
});
it("does not publish OFF when recovery prerequisites fail", async () => {
  getState.mockResolvedValue({
    phase: "OFFLINE",
    offlineActivatedAt: "2026-10-22T00:00Z",
  });
  recovery.mockResolvedValue({
    database: true,
    redis: false,
    errors: ["Redis unavailable"],
  });
  expect((await DELETE(request({ reason: "Recovery verified" }))).status).toBe(
    503,
  );
  expect(setState).not.toHaveBeenCalled();
});

it("returns a retryable partial setup while preserving the OFFLINE gate", async () => {
  drain.mockResolvedValue({
    remainingSessions: 2,
    remainingChannelFreezes: 1,
    errors: ["remaining backlog"],
  });
  const response = await POST(
    request({ phase: "OFFLINE", reason: "Database maintenance" }),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    phase: "OFFLINE",
    setup: { remainingSessions: 2, remainingChannelFreezes: 1 },
  });
  expect(setState).toHaveBeenCalledWith("OFFLINE", expect.anything());
  expect(audit).not.toHaveBeenCalled();
});
it("writes no second activation row when another request stamped the window first", async () => {
  stampOffline.mockResolvedValue({ count: 0 });
  const response = await POST(
    request({ phase: "OFFLINE", reason: "Database maintenance" }),
  );
  expect(response.status).toBe(200);
  expect(audit).not.toHaveBeenCalled();
});
it("requires acknowledged setup before recovering an uncertain OFFLINE activation", async () => {
  getState.mockResolvedValue({ phase: "OFFLINE", offlineActivatedAt: null });
  expect((await DELETE(request({ reason: "Recovery verified" }))).status).toBe(
    503,
  );
  expect(recovery).not.toHaveBeenCalled();
  expect(unfreeze).not.toHaveBeenCalled();
  expect(setState).not.toHaveBeenCalled();
});
it("does not rerun recovery after an already-ended window", async () => {
  expect((await DELETE(request({ reason: "Recovery verified" }))).status).toBe(
    200,
  );
  expect(recovery).not.toHaveBeenCalled();
  expect(unfreeze).not.toHaveBeenCalled();
  expect(setState).toHaveBeenCalledWith("OFF", {
    actor: { userId: "admin", role: "ADMIN" },
    auditReason: "Recovery verified",
  });
});
it("does not transition when authoritative state cannot be read", async () => {
  getState.mockRejectedValue(new Error("database unavailable"));
  expect((await DELETE(request({ reason: "Recovery verified" }))).status).toBe(
    503,
  );
  expect(setState).not.toHaveBeenCalled();
});
