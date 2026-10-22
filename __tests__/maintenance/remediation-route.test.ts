/** @jest-environment node */
import { NextRequest, NextResponse } from "next/server";
const auth = jest.fn();
const freshness = jest.fn();
const createRequest = jest.fn();
const createItems = jest.fn();
const audit = jest.fn();
const transaction = jest.fn();
const findRequests = jest.fn();
const tx = {
  maintenanceWindow: {
    findFirst: jest.fn(async () => ({ id: "window" })),
  },
  maintenanceRemediation: {
    createMany: (...args: unknown[]) => createRequest(...args),
  },
  maintenanceRemediationItem: {
    createMany: (...args: unknown[]) => createItems(...args),
  },
};
jest.mock("../../lib/auth-helpers", () => ({ requireAdminAuth: () => auth() }));
jest.mock("../../lib/auth/step-up", () => ({
  requireFreshSession: (...args: unknown[]) => freshness(...args),
}));
jest.mock("../../lib/backoffice/ops-action-log", () => ({
  opsReasonSchema: jest.requireActual("zod").z.string().trim().min(5).max(1000),
  recordOpsAction: (...args: unknown[]) => audit(...args),
}));
jest.mock("../../lib/observability/throttled-capture", () => ({
  captureThrottled: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (run: (value: typeof tx) => Promise<unknown>) =>
      transaction(run),
    maintenanceWindow: { findFirst: async () => ({ id: "window" }) },
    maintenanceRemediation: {
      findMany: (...args: unknown[]) => findRequests(...args),
    },
    appointment: {
      findMany: async () => [
        {
          id: "booking",
          appointmentType: "CONSULTATION",
          occurrences: [
            {
              startsAt: new Date("2026-10-22T01:00Z"),
              endsAt: new Date("2026-10-22T02:00Z"),
            },
          ],
          participants: [],
          _count: { occurrences: 1, participants: 0 },
        },
      ],
    },
  },
}));
jest.mock("../../actions/maintenance/freeze-appointments", () => ({
  freezeAppointments: jest.fn(),
}));
jest.mock("../../lib/booking/transitions", () => ({
  SLOT_RESCHEDULABLE_FROM: ["SCHEDULED", "RESCHEDULED"],
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({ withCronLock: jest.fn() }));
jest.mock("../../lib/maintenance-cron", () => ({
  assertNotInMaintenance: jest.fn(),
}));
import {
  POST,
  GET,
} from "../../app/api/admin/maintenance/booking-remediation/route";
import { previewRemediation } from "../../lib/maintenance-remediation";
const input = {
  windowId: "window",
  startsAt: "2026-10-22T01:00:00Z",
  endsAt: "2026-10-22T02:00:00Z",
};
const request = (body: unknown) =>
  new NextRequest("http://test/api/admin/maintenance/booking-remediation", {
    method: "POST",
    body: JSON.stringify(body),
  });
beforeEach(() => {
  jest.clearAllMocks();
  process.env.BETTER_AUTH_SECRET = "isolated-route-test-secret";
  auth.mockResolvedValue({ session: { user: { id: "admin" } } });
  freshness.mockReturnValue(null);
  createRequest.mockResolvedValue({ count: 1 });
  transaction.mockImplementation((run) => run(tx));
  findRequests.mockResolvedValue([]);
});
it("requires ADMIN authorization before previewing or queueing", async () => {
  auth.mockResolvedValue({
    error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  });
  expect((await POST(request(input))).status).toBe(403);
  expect(transaction).not.toHaveBeenCalled();
});
it("requires a fresh session before accepting confirmation", async () => {
  freshness.mockReturnValue(
    NextResponse.json({ error: "Re-authenticate" }, { status: 401 }),
  );
  expect((await POST(request(input))).status).toBe(401);
  expect(transaction).not.toHaveBeenCalled();
});
it("commits the request, selected items and ADMIN audit through the same transaction", async () => {
  const preview = await previewRemediation(input, "admin");
  const response = await POST(
    request({
      token: preview.token,
      confirmation: preview.confirmation,
      reason: "Bookings disrupted by maintenance",
    }),
  );
  expect(response.status).toBe(202);
  expect(createItems).toHaveBeenCalledWith({
    data: [{ remediationId: expect.any(String), appointmentId: "booking" }],
  });
  expect(audit).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({
      actorUserId: "admin",
      action: "maintenance.booking-remediation.confirm",
    }),
  );
  expect(transaction).toHaveBeenCalledTimes(1);
});
it("reuses a confirmed request without duplicate items or audit rows", async () => {
  createRequest.mockResolvedValue({ count: 0 });
  const preview = await previewRemediation(input, "admin");
  expect(
    (
      await POST(
        request({
          token: preview.token,
          confirmation: preview.confirmation,
          reason: "Retry confirmed maintenance request",
        }),
      )
    ).status,
  ).toBe(202);
  expect(createItems).not.toHaveBeenCalled();
  expect(audit).not.toHaveBeenCalled();
});
it("returns a safe operational failure when the durable transaction fails", async () => {
  transaction.mockRejectedValue(
    new Error('relation "MaintenanceRemediation" missing'),
  );
  const preview = await previewRemediation(input, "admin");
  const response = await POST(
    request({
      token: preview.token,
      confirmation: preview.confirmation,
      reason: "Bookings disrupted by maintenance",
    }),
  );
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain("relation");
});
it("bounds request history and scopes it to the chosen window", async () => {
  const response = await GET(
    new NextRequest(
      "http://test/api/admin/maintenance/booking-remediation?windowId=window",
    ),
  );
  expect(response.status).toBe(200);
  expect(findRequests).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { windowId: "window" },
      take: 10,
      select: expect.objectContaining({
        items: expect.objectContaining({ take: 20 }),
      }),
    }),
  );
});
