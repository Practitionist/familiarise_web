/**
 * @jest-environment node
 */

/**
 * A paid trial whose session was held is not cancellable and never quotes
 * infinite notice; one still waiting for its first confirmed session does.
 */
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@/lib/enterprise/system-events", () => ({
  recordSystemErrorSafe: jest.fn(),
}));

import type { Tx } from "@/lib/prisma";
import {
  quoteTrialRefund,
  trialCancelWindowRefusal,
} from "@/lib/trials/cancellation";

const HOUR = 3_600_000;

type Occ = {
  startsAt: Date;
  endsAt: Date;
  ordinal: number;
  completionStatus: string;
  isTentative: boolean;
};

const occ = (
  startHours: number,
  completionStatus: string,
  isTentative = false,
): Occ => ({
  startsAt: new Date(Date.now() + startHours * HOUR),
  endsAt: new Date(Date.now() + (startHours + 1) * HOUR),
  ordinal: 1,
  completionStatus,
  isTentative,
});

function fakeDb(occurrences: Occ[]) {
  return {
    payment: {
      findFirst: jest.fn(async () => ({
        id: "pay-1",
        amount: 50_000,
        currency: "INR",
        paymentIntent: "order_trial",
        refunds: [],
        disputes: [],
      })),
    },
    appointment: {
      findFirst: jest.fn(async () => ({
        id: "appt-trial",
        cancellationPolicy: null,
        payment: [],
        subscription: null,
        consultation: null,
        trial: { consulteeProfile: { userId: "user-buyer" } },
        occurrences,
      })),
    },
    appointmentOccurrence: {
      findMany: jest.fn(
        async ({ where }: { where: { completionStatus?: string } }) =>
          occurrences.filter(
            (o) =>
              !where.completionStatus ||
              o.completionStatus === where.completionStatus,
          ),
      ),
    },
    rescheduleRequest: { findMany: jest.fn(async () => []) },
    refund: { findMany: jest.fn(async () => []) },
  } as unknown as Tx;
}

const quote = (db: Tx) =>
  quoteTrialRefund(
    {
      appointmentId: "appt-trial",
      paymentId: "pay-1",
      isConsultantInitiated: false,
    },
    db,
  );

describe("a delivered paid trial", () => {
  it.each([
    ["COMPLETED", occ(-3, "COMPLETED")],
    ["UNVERIFIED (awaiting a human)", occ(-3, "UNVERIFIED")],
    ["past its end, not yet swept", occ(-3, "SCHEDULED")],
  ])("is refused at every cancel door when %s", async (_label, row) => {
    const refusal = await trialCancelWindowRefusal("appt-trial", fakeDb([row]));
    expect(refusal?.code).toBe("SESSION_ALREADY_DELIVERED");
    expect(refusal?.httpStatus).toBe(409);
  });

  it("quotes nothing back to the buyer, never infinite notice", async () => {
    const q = await quote(fakeDb([occ(-3, "COMPLETED")]));
    expect(q?.refundPct).toBe(0);
    expect(q?.estimatedRefundPaise).toBe(0);
  });

  it("is refused while its session is under way", async () => {
    const refusal = await trialCancelWindowRefusal(
      "appt-trial",
      fakeDb([occ(-0.25, "SCHEDULED")]),
    );
    expect(refusal?.code).toBe("SESSION_IN_PROGRESS");
  });
});

describe("a paid trial still waiting for its session", () => {
  it("refunds in full when no session was ever confirmed", async () => {
    const q = await quote(fakeDb([]));
    expect(q?.refundPct).toBe(100);
    expect(q?.estimatedRefundPaise).toBe(50_000);
    expect(await trialCancelWindowRefusal("appt-trial", fakeDb([]))).toBeNull();
  });

  it("tiers on its confirmed session's notice", async () => {
    const q = await quote(fakeDb([occ(6, "SCHEDULED")]));
    expect(q?.refundPct).toBe(50);
    expect(q?.estimatedRefundPaise).toBe(25_000);
  });
});
