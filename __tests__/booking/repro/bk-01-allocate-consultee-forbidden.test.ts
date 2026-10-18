/**
 * @jest-environment node
 */

// Invariant: only the plan's consultant, a host-org operator or staff may allocate; a consultee gets 403 ALLOCATE_FORBIDDEN.

const allocate = jest.fn();
jest.mock("../../../lib/booking/allocation", () => ({
  allocate: (...a: unknown[]) => allocate(...a),
}));
const resolveEventHostActor = jest.fn();
jest.mock("../../../lib/auth-helpers", () => ({
  requireApiAuth: async () => ({
    session: { user: { id: "u-consultee", role: "CONSULTEE" } },
  }),
  authorizeEventAccess: async () => null,
  resolveEventHostActor: (...a: unknown[]) => resolveEventHostActor(...a),
}));
jest.mock("../../../lib/rate-limit", () => ({
  applyRateLimit: async () => null,
  eventMutationLimiter: {},
}));
jest.mock("../../../lib/booking/approve-request", () => ({
  mintApprovalPaymentAfterCommit: jest.fn(),
  approvalMintConflict: () => null,
}));
jest.mock("../../../lib/enterprise/system-events", () => ({
  recordSystemErrorSafe: jest.fn().mockResolvedValue(undefined),
}));

import { NextRequest } from "next/server";
import { handleAllocate } from "../../../lib/scheduling/allocate-route";

const C_ID = "clzzzzzzz000consultation1";
const patch = () =>
  handleAllocate(
    new NextRequest("http://localhost/x", {
      method: "PATCH",
      body: JSON.stringify({ isAuto: false, useRequestedSlots: true }),
      headers: { "content-type": "application/json" },
    }),
    "consultation",
    C_ID,
  );

beforeEach(() => {
  jest.clearAllMocks();
  allocate.mockResolvedValue({
    success: true,
    outcome: "approved",
    appointments: [],
  });
});

describe("handleAllocate actor check", () => {
  it("consultee approving their own request is refused with 403 ALLOCATE_FORBIDDEN", async () => {
    resolveEventHostActor.mockResolvedValue(null);
    const res = await patch();
    expect(allocate).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ errorCode: "ALLOCATE_FORBIDDEN" });
  });

  it("the plan's consultant may allocate", async () => {
    resolveEventHostActor.mockResolvedValue("consultant");
    const res = await patch();
    expect(res.status).toBe(200);
    expect(allocate).toHaveBeenCalledTimes(1);
  });
});
