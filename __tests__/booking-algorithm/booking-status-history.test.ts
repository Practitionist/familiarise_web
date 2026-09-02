/**
 * @jest-environment node
 */

/**
 * #1319 A12 — every guarded transition appends one BookingStatusHistory row in
 * the same tx, AFTER the compare-and-set succeeded, and never when it failed.
 */

import {
  transitionConsultationRequest,
  transitionSubscriptionRequest,
  transitionWebinarEvent,
  transitionClassEvent,
  transitionRescheduleRequest,
} from "../../lib/booking/transitions";
import { IllegalTransitionError } from "../../lib/enterprise/transitions";

function makeTx(model: string, opts: { count: number; before: string | null }) {
  const order: string[] = [];
  const findUnique = jest.fn(async () => {
    order.push("read");
    return opts.before === null ? null : { status: opts.before };
  });
  const updateMany = jest.fn(async () => {
    order.push("cas");
    return { count: opts.count };
  });
  const create = jest.fn(async (_args: { data: Record<string, unknown> }) => {
    order.push("history");
    return {};
  });
  const tx = {
    [model]: { findUnique, updateMany },
    bookingStatusHistory: { create },
  } as never;
  return { tx, findUnique, updateMany, create, order };
}

const cases: Array<{
  name: string;
  model: string;
  entity: string;
  run: (tx: never) => Promise<void>;
  to: string;
}> = [
  {
    name: "consultation",
    model: "consultation",
    entity: "CONSULTATION",
    to: "APPROVED",
    run: (tx) =>
      transitionConsultationRequest(tx, {
        where: { id: "c1" },
        to: "APPROVED",
        actorUserId: "u1",
        reason: "ok",
      }),
  },
  {
    name: "subscription",
    model: "subscription",
    entity: "SUBSCRIPTION",
    to: "CANCELLED",
    run: (tx) =>
      transitionSubscriptionRequest(tx, {
        where: { id: "s1" },
        to: "CANCELLED",
      }),
  },
  {
    name: "webinar",
    model: "webinar",
    entity: "WEBINAR",
    to: "COMPLETED",
    run: (tx) =>
      transitionWebinarEvent(tx, { where: { id: "w1" }, to: "COMPLETED" }),
  },
  {
    name: "class",
    model: "class",
    entity: "CLASS",
    to: "CANCELLED",
    run: (tx) =>
      transitionClassEvent(tx, { where: { id: "k1" }, to: "CANCELLED" }),
  },
  {
    name: "reschedule request",
    model: "rescheduleRequest",
    entity: "RESCHEDULE_REQUEST",
    to: "ACCEPTED",
    run: (tx) =>
      transitionRescheduleRequest(tx, { where: { id: "r1" }, to: "ACCEPTED" }),
  },
];

describe.each(cases)(
  "$name transition history",
  ({ model, entity, run, to }) => {
    it("reads the from-status, runs the CAS, then appends one history row", async () => {
      const { tx, create, order } = makeTx(model, {
        count: 1,
        before: "PENDING",
      });
      await run(tx);
      expect(order).toEqual(["read", "cas", "history"]);
      expect(create).toHaveBeenCalledTimes(1);
      const row = create.mock.calls[0][0].data;
      expect(row).toMatchObject({
        entity,
        fromStatus: "PENDING",
        toStatus: to,
      });
    });

    it("writes no history when the CAS matched zero rows", async () => {
      const { tx, create } = makeTx(model, { count: 0, before: "PENDING" });
      await expect(run(tx)).rejects.toBeInstanceOf(IllegalTransitionError);
      expect(create).not.toHaveBeenCalled();
    });

    it("logs UNKNOWN when the row could not be pre-read", async () => {
      const { tx, create } = makeTx(model, { count: 1, before: null });
      await run(tx);
      expect(create.mock.calls[0][0].data.fromStatus).toBe("UNKNOWN");
    });
  },
);

describe("attribution rides the row", () => {
  it("actor and reason are stored when given", async () => {
    const { tx, create } = makeTx("consultation", {
      count: 1,
      before: "PENDING",
    });
    await transitionConsultationRequest(tx, {
      where: { id: "c1" },
      to: "APPROVED",
      actorUserId: "u1",
      reason: "consultant approved",
      organizationId: "org1",
      appointmentId: "a1",
    });
    expect(create.mock.calls[0][0].data).toMatchObject({
      actorUserId: "u1",
      reason: "consultant approved",
      organizationId: "org1",
      appointmentId: "a1",
    });
  });
});
