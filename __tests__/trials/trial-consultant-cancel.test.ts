/**
 * @jest-environment node
 */

/**
 * The expert cancels a scheduled trial through trial DELETE: the learner is
 * refunded in full (the consultant tier, whatever the notice), the refund-owed
 * marker is stamped in the cancel commit under `trial-cancel:<trial>:<payment>`
 * with the amount the dialog showed, and a strike is recorded in the same
 * transaction. A free trial owes nothing but still records the strike. The
 * learner's own cancel records no strike. An operator who is not a party is
 * refused on DELETE and on every PATCH status. From 15 minutes before the start
 * nothing is cancelled, and the PATCH no longer cancels a scheduled trial.
 */

const state = {
  session: {
    id: "u-expert",
    role: "CONSULTANT",
    consultantProfileId: "cp-1" as string | null,
    consulteeProfileId: null as string | null,
  },
  trialStatus: "SCHEDULED",
  paid: true,
  window: "BEFORE" as "BEFORE" | "IN_PROGRESS" | "DELIVERED",
  /** Hours from now to the trial's session. */
  hoursAhead: 2,
};
const calls: string[] = [];
const stampRefundOwed = jest.fn(async () => {
  calls.push("stamp");
  return true;
});
const recordExpertStrike = jest.fn(async () => {
  calls.push("strike");
  return true;
});
const refundCancelledTrial = jest.fn(
  async (args: { owed: { amountPaise: number | null } | null }) =>
    args.owed
      ? { refundPct: 100, amountRefundedPaise: args.owed.amountPaise ?? 0 }
      : null,
);
const transitionTrial = jest.fn(async () => {
  calls.push("cancel");
});
const expirePendingPaymentsInTx = jest.fn(async () => {
  calls.push("expire");
  return { expired: 0, gatewayCancels: [] };
});
const cancelGatewayOrders = jest.fn(async () => undefined);

jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: async () => ({ session: { user: state.session } }),
  isPrivileged: (role: string) => role === "ADMIN" || role === "STAFF",
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: async () => null,
  eventMutationLimiter: {},
}));
jest.mock("../../lib/novu", () => ({
  notifyTrialCancelled: jest.fn(async () => []),
  notifyTrialScheduled: jest.fn(),
  notifyTrialCompleted: jest.fn(),
}));
jest.mock("../../lib/email/senders/booking", () => ({
  stageTrialLifecycleEmail: jest.fn(async () => []),
  prepareTrialLifecycleEmail: jest.fn(async () => null),
  prepareTrialScheduledEmail: jest.fn(),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: jest.fn(async () => undefined),
}));
jest.mock("../../lib/trials/refund-bell", () => ({
  stageTrialRefundedBell: jest.fn(async () => undefined),
}));
jest.mock("../../lib/booking/transitions", () => ({
  transitionTrial: (...a: unknown[]) => transitionTrial(...(a as [])),
}));
jest.mock("../../lib/booking/reschedule-decline", () => ({
  declineOpenReschedules: jest.fn(async () => {
    calls.push("decline-reschedules");
    return 0;
  }),
}));
jest.mock("../../lib/booking/pending-payment-expiry", () => ({
  expirePendingPaymentsInTx: (...a: unknown[]) =>
    expirePendingPaymentsInTx(...(a as [])),
  cancelGatewayOrders: (...a: unknown[]) => cancelGatewayOrders(...(a as [])),
}));
jest.mock("../../lib/booking/expert-reliability", () => ({
  recordExpertStrike: (...a: unknown[]) => recordExpertStrike(...(a as [])),
}));
jest.mock("../../lib/payments/operations/refund-owed", () => ({
  stampRefundOwed: (...a: unknown[]) => stampRefundOwed(...(a as [])),
  heldMarkerRefusal: jest.fn(),
  recordRefundNeedsSupport: jest.fn(),
}));
jest.mock("../../lib/booking/cancellation-scope", () => ({
  LIVE_SLOT_WHERE: { deletedAt: null },
  readCancelWindowState: async () => state.window,
  resolveBookingRefundContext: async () => ({
    policy: null,
    hoursUntilNextSession: state.hoursAhead,
    slotsTotal: 1,
    confirmedSlotsTotal: 1,
    sessionsRemaining: 1,
  }),
}));
jest.mock("../../lib/trials/cancellation", () => {
  const actual = jest.requireActual("../../lib/trials/cancellation");
  return {
    ...actual,
    softCancelTrialAppointmentInTx: jest.fn(async () => {
      calls.push("tombstone");
      return 1;
    }),
    refundCancelledTrial: (...a: unknown[]) =>
      refundCancelledTrial(
        ...(a as [{ owed: { amountPaise: number | null } | null }]),
      ),
  };
});
jest.mock("../../utils/appointmentlock", () => ({
  withAppointmentLock: async (_id: string, fn: () => unknown) => fn(),
  lockSlotBatch: jest.fn(),
  unlockSlotBooking: jest.fn(),
  lockConsulteeBooking: jest.fn(),
  unlockConsulteeBooking: jest.fn(),
  BookingLockUnavailableError: class extends Error {},
  AppointmentBusyError: class extends Error {},
}));

const trialRow = () => ({
  id: "trial-1",
  status: state.trialStatus,
  consulteeProfileId: "cee-1",
  consultantProfileId: "cp-1",
  appointmentId: "apt-1",
  paymentId: state.paid ? "pay-1" : null,
  organizationId: null,
  subscriptionPlanId: "plan-1",
  consultantProfile: { id: "cp-1", user: { id: "u-expert", name: "Expert" } },
  consulteeProfile: { user: { id: "u-learner", name: "Learner" } },
  subscriptionPlan: { title: "Mentorship", trialPriceInPaise: 50_000 },
  appointment: null,
});

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    trial: { findUnique: jest.fn(async () => trialRow()) },
    payment: {
      findFirst: jest.fn(async () =>
        state.paid
          ? {
              id: "pay-1",
              amount: 50_000,
              currency: "INR",
              paymentIntent: "order_1",
              refunds: [],
              disputes: [],
            }
          : null,
      ),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        trial: {
          findUniqueOrThrow: jest.fn(async () => ({
            ...trialRow(),
            status: "CANCELLED",
          })),
        },
        appointmentOccurrence: {
          findMany: jest.fn(async () => [{ id: "occ-1" }]),
        },
      }),
    ),
  },
}));

import { NextRequest } from "next/server";
import { DELETE, PATCH } from "../../app/api/trials/[trialId]/route";

const ctx = { params: Promise.resolve({ trialId: "trial-1" }) };
const del = (body: unknown = {}) =>
  DELETE(
    new NextRequest("http://localhost/api/trials/trial-1", {
      method: "DELETE",
      body: JSON.stringify(body),
    }),
    ctx,
  );

const asExpert = () => {
  state.session = {
    id: "u-expert",
    role: "CONSULTANT",
    consultantProfileId: "cp-1",
    consulteeProfileId: null,
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  asExpert();
  state.trialStatus = "SCHEDULED";
  state.paid = true;
  state.window = "BEFORE";
  state.hoursAhead = 2;
});

describe("the expert cancels a scheduled trial", () => {
  it("refunds the paid trial in full, stamps the marker and records a strike in the cancel commit", async () => {
    const res = await del({ confirmedRefundPaise: 50_000 });
    expect(res.status).toBe(200);
    expect(stampRefundOwed).toHaveBeenCalledWith(expect.anything(), {
      paymentId: "pay-1",
      amountPaise: 50_000,
      key: "trial-cancel:trial-1:pay-1",
      reason: expect.stringContaining("consultant-initiated"),
    });
    expect(recordExpertStrike).toHaveBeenCalledWith(expect.anything(), {
      consultantProfileId: "cp-1",
      cause: "EXPERT_CANCEL",
      appointmentId: "apt-1",
      occurrenceIds: ["occ-1"],
      organizationId: null,
    });
    // One transaction: status, strike, reschedules, tombstone, marker.
    expect(calls).toEqual([
      "expire",
      "cancel",
      "strike",
      "decline-reschedules",
      "tombstone",
      "stamp",
    ]);
    expect((await res.json()).refund).toEqual({
      refundPct: 100,
      amountRefundedPaise: 50_000,
    });
  });

  it("a full refund even inside the learner's 0% tier: the consultant tier ignores notice", async () => {
    state.hoursAhead = 0.5;
    const res = await del({ confirmedRefundPaise: 50_000 });
    expect(res.status).toBe(200);
    expect(stampRefundOwed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amountPaise: 50_000 }),
    );
  });

  it("refuses a stale confirmation with the current quote and commits nothing", async () => {
    const res = await del({ confirmedRefundPaise: 10_000 });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("REFUND_QUOTE_CHANGED");
    expect(body.quote.estimatedRefundPaise).toBe(50_000);
    expect(transitionTrial).not.toHaveBeenCalled();
    expect(recordExpertStrike).not.toHaveBeenCalled();
  });

  it("a free trial owes nothing but still records the strike", async () => {
    state.paid = false;
    const res = await del();
    expect(res.status).toBe(200);
    expect(stampRefundOwed).not.toHaveBeenCalled();
    expect(recordExpertStrike).toHaveBeenCalledTimes(1);
  });

  it("nothing is cancelled from 15 minutes before the start", async () => {
    state.window = "IN_PROGRESS";
    const res = await del({ confirmedRefundPaise: 50_000 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("SESSION_IN_PROGRESS");
    expect(transitionTrial).not.toHaveBeenCalled();
  });
});

describe("the cancel notices commit with the cancel", () => {
  it("a staging failure rolls the cancel back instead of losing the notice", async () => {
    const { notifyTrialCancelled } = jest.requireMock("../../lib/novu") as {
      notifyTrialCancelled: jest.Mock;
    };
    notifyTrialCancelled.mockRejectedValueOnce(new Error("outbox down"));

    const res = await del({ confirmedRefundPaise: 50_000 });

    expect(res.status).toBe(500);
    expect(refundCancelledTrial).not.toHaveBeenCalled();
  });

  it("stages the notices on the cancel transaction", async () => {
    const { notifyTrialCancelled } = jest.requireMock("../../lib/novu") as {
      notifyTrialCancelled: jest.Mock;
    };
    await del({ confirmedRefundPaise: 50_000 });

    expect(notifyTrialCancelled.mock.calls[0][2]).toMatchObject({
      tx: expect.anything(),
      deferAttempt: true,
      required: { kind: "CANCELLED_BY_HOST", recipients: ["u-learner"] },
    });
  });
});

describe("cancelling a held trial", () => {
  it("expires its pending payment on the cancel transaction, before the trial moves", async () => {
    state.trialStatus = "AWAITING_PAYMENT";
    state.paid = false;
    const cancels = [{ paymentIntent: "order_9", gateway: "RAZORPAY" }];
    expirePendingPaymentsInTx.mockImplementationOnce(async () => {
      calls.push("expire");
      return { expired: 1, gatewayCancels: cancels as never[] };
    });
    const res = await del();
    expect(res.status).toBe(200);
    const [expireTx, expireArgs] = expirePendingPaymentsInTx.mock
      .calls[0] as unknown as [unknown, { appointmentId: string }];
    expect(expireArgs.appointmentId).toBe("apt-1");
    expect(expireTx).toBe((transitionTrial.mock.calls[0] as unknown[])[0]);
    expect(calls.slice(0, 2)).toEqual(["expire", "cancel"]);
    expect(cancelGatewayOrders).toHaveBeenCalledWith(
      cancels,
      expect.objectContaining({ appointmentId: "apt-1" }),
    );
  });
});

describe("cancels that record no strike", () => {
  it("the learner's own cancel", async () => {
    state.session = {
      id: "u-learner",
      role: "CONSULTEE",
      consultantProfileId: null,
      consulteeProfileId: "cee-1",
    };
    state.hoursAhead = 48;
    const res = await del({ confirmedRefundPaise: 50_000 });
    expect(res.status).toBe(200);
    expect(recordExpertStrike).not.toHaveBeenCalled();
  });

  it("staff who bought the trial cancel as the learner", async () => {
    state.session = {
      id: "u-learner",
      role: "STAFF",
      consultantProfileId: null,
      consulteeProfileId: "cee-1",
    };
    state.hoursAhead = 48;
    const res = await del({ confirmedRefundPaise: 50_000 });
    expect(res.status).toBe(200);
    expect(recordExpertStrike).not.toHaveBeenCalled();
  });

  it("a trial still awaiting payment", async () => {
    state.trialStatus = "AWAITING_PAYMENT";
    state.paid = false;
    const res = await del();
    expect(res.status).toBe(200);
    expect(recordExpertStrike).not.toHaveBeenCalled();
  });
});

describe("one door for a scheduled trial", () => {
  it("PATCH CANCELLED on a scheduled trial answers 409 USE_CANCEL_ENDPOINT", async () => {
    const res = await PATCH(
      new NextRequest("http://localhost/api/trials/trial-1", {
        method: "PATCH",
        body: JSON.stringify({ status: "CANCELLED" }),
      }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("USE_CANCEL_ENDPOINT");
    expect(transitionTrial).not.toHaveBeenCalled();
  });

  it("the trial map allows SCHEDULED → CANCELLED", () => {
    const actual = jest.requireActual<
      typeof import("../../lib/booking/transitions")
    >("../../lib/booking/transitions");
    expect(actual.TRIAL_ALLOWED_FROM.CANCELLED).toContain("SCHEDULED");
  });
});

describe("an operator who is not a party", () => {
  const asOperator = (role: "ADMIN" | "STAFF") => {
    state.session = {
      id: "u-ops",
      role,
      consultantProfileId: null,
      consulteeProfileId: null,
    };
  };

  it.each(["ADMIN", "STAFF"] as const)(
    "%s is refused the trial cancel and nothing is refunded",
    async (role) => {
      asOperator(role);
      const res = await del({ confirmedRefundPaise: 50_000 });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("PLATFORM_CANCEL_DOOR_REQUIRED");
      expect(transitionTrial).not.toHaveBeenCalled();
      expect(stampRefundOwed).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["AWAITING_PAYMENT", "CANCELLED"],
    ["SCHEDULED", "COMPLETED"],
  ])("is refused moving a %s trial to %s", async (from, to) => {
    asOperator("STAFF");
    state.trialStatus = from;
    state.paid = false;
    const res = await PATCH(
      new NextRequest("http://localhost/api/trials/trial-1", {
        method: "PATCH",
        body: JSON.stringify({ status: to }),
      }),
      ctx,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("PLATFORM_CANCEL_DOOR_REQUIRED");
    expect(transitionTrial).not.toHaveBeenCalled();
  });
});
