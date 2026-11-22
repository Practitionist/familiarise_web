/**
 * @jest-environment node
 */

/**
 * The back-office subscription CANCEL only marks a row cancelled, so it is for
 * a subscription with no booking. One with a booking is refused: its sessions,
 * seats and refund belong to the booking's cancel.
 */

type Door = {
  run: (ctx: {
    body: { subscriptionId: string; action: "CANCEL"; reason: string };
    actor: { userId: string };
  }) => Promise<{ status: number; response: unknown }>;
};
const mockDoors: Door[] = [];
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async () => ({ error: null })),
}));
jest.mock("../../lib/backoffice/ops-action-log", () => ({
  withOpsAction: (_p: string, _a: string, _shape: object, door: Door) => {
    mockDoors.push(door);
    return jest.fn();
  },
}));
const mockTransition = jest.fn();
jest.mock("../../lib/booking/transitions", () => ({
  ...jest.requireActual("../../lib/booking/transitions"),
  transitionSubscriptionRequest: (...args: unknown[]) =>
    mockTransition(...args),
}));
jest.mock("../../lib/prisma", () => {
  const client: Record<string, unknown> = {
    subscription: { findUnique: jest.fn() },
  };
  client.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(client));
  return { __esModule: true, default: client };
});

import prisma from "@/lib/prisma";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";

const m = prisma as unknown as {
  subscription: { findUnique: jest.Mock };
};

const cancel = () =>
  mockDoors[0].run({
    body: {
      subscriptionId: "sub-1",
      action: "CANCEL",
      reason: "Duplicate row from a failed import",
    },
    actor: { userId: "u-ops" },
  });

// Loaded after the door list above exists: the route registers its door on import.
beforeAll(async () => {
  await import("@/app/api/admin/subscriptions/route");
});
beforeEach(() => jest.clearAllMocks());

describe("POST /api/admin/subscriptions CANCEL", () => {
  it("refuses a subscription that has a booking and writes nothing", async () => {
    m.subscription.findUnique.mockResolvedValue({
      id: "sub-1",
      status: "APPROVED",
      appointment: { id: "appt-1" },
    });

    const refusal = await cancel().catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(OpsRefusal);
    expect(refusal).toMatchObject({
      code: "USE_CANCEL_DOOR",
      httpStatus: 409,
      detail: { appointmentId: "appt-1" },
    });
    expect(mockTransition).not.toHaveBeenCalled();
  });

  it("marks a subscription with no booking cancelled", async () => {
    m.subscription.findUnique.mockResolvedValue({
      id: "sub-1",
      status: "PENDING",
      appointment: null,
    });

    const result = await cancel();

    expect(result.status).toBe(200);
    expect(mockTransition).toHaveBeenCalledTimes(1);
    expect(mockTransition.mock.calls[0][1]).toMatchObject({
      where: { id: "sub-1" },
      to: "CANCELLED",
      actorUserId: "u-ops",
    });
  });
});
