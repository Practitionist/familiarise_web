/**
 * @jest-environment node
 */

/**
 * #1569 — an earning is released after the CALL, not after the capture. The
 * hold anchors on the later of the capture and the last live occurrence's
 * end, is recomputed whenever the live set changes, and never moves earlier
 * than it already is.
 */

import {
  computeHoldUntil,
  recomputeEarningsHold,
} from "@/lib/payments/payouts/earnings-hold";

const HOUR = 60 * 60 * 1000;
const at = (iso: string) => new Date(iso);

describe("computeHoldUntil", () => {
  it("anchors on the last call's end when it is after the capture", () => {
    expect(
      computeHoldUntil({
        capturedAt: at("2026-09-01T10:00:00Z"),
        lastOccurrenceEndsAt: at("2026-09-20T11:00:00Z"),
        holdHours: 24,
      }),
    ).toEqual(at("2026-09-21T11:00:00Z"));
  });

  it("anchors on the capture when no call is scheduled yet", () => {
    expect(
      computeHoldUntil({
        capturedAt: at("2026-09-01T10:00:00Z"),
        lastOccurrenceEndsAt: null,
        holdHours: 168,
      }),
    ).toEqual(new Date(at("2026-09-01T10:00:00Z").getTime() + 168 * HOUR));
  });
});

describe("recomputeEarningsHold", () => {
  function db(opts: {
    lastEnd: Date | null;
    earnings: { id: string; createdAt: Date; holdUntil: Date }[];
  }) {
    const update = jest.fn(async () => ({}));
    const client = {
      appointment: {
        findUnique: jest.fn(async () => ({
          appointmentType: "SUBSCRIPTION",
          payment: [{ id: "pay-1" }],
        })),
      },
      appointmentOccurrence: {
        findFirst: jest.fn(async () =>
          opts.lastEnd ? { endsAt: opts.lastEnd } : null,
        ),
      },
      consultantEarnings: {
        findMany: jest.fn(async () => opts.earnings),
        update,
      },
    };
    return { update, client: client as unknown as never, mocks: client };
  }

  it("extends a PENDING hold to the last live call's end plus the hold hours", async () => {
    // A subscription captured on 1 Sep with its first allocation landing a
    // call on 20 Sep: the capture-time hold (7 days) would release the money
    // before any call was held.
    const { client, update } = db({
      lastEnd: at("2026-09-20T11:00:00Z"),
      earnings: [
        {
          id: "earn-1",
          createdAt: at("2026-09-01T10:00:00Z"),
          holdUntil: at("2026-09-08T10:00:00Z"),
        },
      ],
    });

    expect(await recomputeEarningsHold(client, "appt-1")).toBe(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: "earn-1" },
      data: { holdUntil: at("2026-09-27T11:00:00Z") },
    });
  });

  it("leaves a null hold alone (#1766 — an undelivered tranche is stamped by the completion path)", async () => {
    const { client, update, mocks } = db({
      lastEnd: at("2026-09-20T11:00:00Z"),
      earnings: [],
    });

    expect(await recomputeEarningsHold(client, "appt-1")).toBe(0);
    expect(update).not.toHaveBeenCalled();
    // The predicate itself excludes NULL rows, so the SQL never sees them.
    expect(mocks.consultantEarnings.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ holdUntil: { not: null } }),
      }),
    );
  });

  it("never moves a hold earlier than it already is", async () => {
    // The call was rescheduled EARLIER; the hold the capture promised stands.
    const { client, update } = db({
      lastEnd: at("2026-09-02T11:00:00Z"),
      earnings: [
        {
          id: "earn-1",
          createdAt: at("2026-09-01T10:00:00Z"),
          holdUntil: at("2026-09-27T11:00:00Z"),
        },
      ],
    });

    expect(await recomputeEarningsHold(client, "appt-1")).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });
});
