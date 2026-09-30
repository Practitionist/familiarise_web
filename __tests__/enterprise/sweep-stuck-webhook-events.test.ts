/**
 * @jest-environment node
 */

/**
 * #785 (task #10) — B5 stuck-webhook sweeper. Re-drives WebhookEvent rows left
 * processed=false after an after()-callback crash, reconstructing the envelope
 * the per-event schemas require (entity/account_id/contains/created_at) and
 * routing through the real dispatch. Pins the loop + reconstruction + the
 * success/fail/throw accounting.
 */

// Factories create the jest.fn()s inline (retrieved via the mocked modules
// below) — referencing outer consts here would hit import-hoisting init order.
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    webhookEvent: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      // claim CAS before each re-drive
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  },
}));
jest.mock("../../app/api/webhooks/razorpay-dispatch", () => ({
  processRazorpayWebhookEvent: jest.fn(),
}));

// #476 — the sweep cores are now wrapped in withCronLock; pass through so
// these unit tests exercise the sweep logic, not the lock (covered in
// with-cron-lock.test.ts).
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: jest.fn((_job: string, _opts: unknown, fn: () => unknown) =>
    fn(),
  ),
  CronLockHeldError: class CronLockHeldError extends Error {},
  CronLockUnavailableError: class CronLockUnavailableError extends Error {},
  LONG_JOB_TTL_MS: 35 * 60 * 1000,
}));

import prisma from "../../lib/prisma";
import { processRazorpayWebhookEvent } from "../../app/api/webhooks/razorpay-dispatch";
import { sweepStuckWebhookEvents } from "../../scripts/cleanup/sweep-stuck-webhook-events";

const mockWe = (
  prisma as unknown as {
    webhookEvent: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      // #1205-triage — the sweeper's claim CAS before each re-drive.
      updateMany: jest.Mock;
    };
  }
).webhookEvent;
const mockProcess = processRazorpayWebhookEvent as jest.Mock;

const stuckRow = (over: Record<string, unknown> = {}) => ({
  eventId: "payment.captured:pay_1",
  eventType: "payment.captured",
  payload: { payment: { entity: { id: "pay_1" } } },
  receivedAt: new Date("2026-06-01T00:00:00Z"),
  claimedAt: null as Date | null | undefined,
  ...over,
});

/**
 * #1829 — the sweeper writes through BOTH prisma shapes: `updateMany(where, data)`
 * and `update({ where, data })`. A helper that destructures the second
 * positional argument matches the first shape and silently misses the second,
 * which reads as "the code never ran" rather than "the assertion looked in the
 * wrong place". Both shapes are flattened to `{ where, data }` here so the
 * assertions below do not have to care.
 */
const writeOf = (call: unknown[]) => {
  const args = call as unknown[];
  const asOne = args[0] as
    | { where?: Record<string, unknown>; data?: Record<string, unknown> }
    | undefined;
  const asTwo = args[1] as { data?: Record<string, unknown> } | undefined;
  return {
    where: asOne?.where ?? {},
    data: asOne?.data ?? asTwo?.data ?? {},
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockWe.update.mockResolvedValue({});
});

describe("sweepStuckWebhookEvents (#785)", () => {
  // #1829 — this test used to assert that the sweeper's own pre-claim CAS lost
  // a race and skipped the re-drive. The pre-claim is GONE, deliberately, and
  // the reason is worth keeping here where the old assertion lived:
  //
  // Claiming before the re-drive stamped `claimedAt = now()`, and
  // `logWebhookEvent` — which the dispatchers call to do their own bookkeeping —
  // then ran its staleness escape ("in progress for more than five minutes ⇒
  // abandoned") against a claim aged ZERO, returned `isNew: false`, and the
  // dispatcher returned having done nothing. So the sweeper could not re-drive
  // the one row shape it exists to rescue: acknowledged by the route, `after()`
  // never completed. Every such row was re-claimed and re-refused for 168 hours
  // and then discarded forever.
  //
  // The exclusion the pre-claim was buying is not lost. `logWebhookEvent`'s own
  // claim is a conditional `updateMany` scoped to the exact `claimedAt` the
  // caller read, so of two racing drivers exactly one write lands — and that is
  // covered where it now lives, in
  // `__tests__/stream/webhook-event-log-claim.test.ts` ("moves claimedAt forward
  // and leaves receivedAt alone", and the stale-takeover case at :116).
  //
  // What this file now pins is the half that is still the sweeper's: it does not
  // write a claim of its own, and it always attempts the re-drive. The
  // dispatcher is mocked here, so the exclusion is necessarily invisible at this
  // layer — which is exactly why the re-drive assertion moved to
  // `__tests__/stream/webhook-sweeper-redrive.test.ts`, where the dispatcher is
  // real and the staleness arithmetic is modelled rather than stubbed.
  it("does NOT pre-claim the row, so the dispatcher's staleness escape can fire", async () => {
    const ev = stuckRow();
    mockWe.findMany.mockResolvedValue([ev]);
    mockWe.updateMany.mockResolvedValue({ count: 0 });
    mockProcess.mockResolvedValue(undefined);
    mockWe.findUnique.mockResolvedValue({ error: null, processed: true });

    await sweepStuckWebhookEvents({ staleMinutes: 6 });

    const claimWrites = (mockWe.updateMany as jest.Mock).mock.calls.filter(
      (c: unknown[]) => "claimedAt" in writeOf(c).data,
    );
    expect(claimWrites).toHaveLength(0);
  });

  it("always attempts the re-drive, and counts it as recovered", async () => {
    const ev = stuckRow();
    mockWe.findMany.mockResolvedValue([ev]);
    mockProcess.mockResolvedValue(undefined);
    mockWe.findUnique.mockResolvedValue({ error: null, processed: true });

    const result = await sweepStuckWebhookEvents({ staleMinutes: 6 });

    expect(processRazorpayWebhookEvent).toHaveBeenCalledTimes(1);
    expect(result.recovered).toBe(1);
  });

  // #1829 — the give-up window still ages on `receivedAt`, which is the property
  // this test existed to protect and which survives the pre-claim's removal.
  // The claim CAS itself moved into `logWebhookEvent` (see the note above and
  // `__tests__/stream/webhook-event-log-claim.test.ts`), so the sweeper's own
  // contribution is now narrower and is asserted narrowly: it writes an attempts
  // counter and nothing else that touches the aging columns.
  it("never touches receivedAt, so the give-up cap cannot be reset by a re-drive", async () => {
    const ev = stuckRow();
    mockWe.findMany.mockResolvedValue([ev]);
    mockProcess.mockResolvedValue(undefined);
    mockWe.findUnique.mockResolvedValue({ error: null, processed: true });

    await sweepStuckWebhookEvents({ staleMinutes: 6 });

    const writes = [
      ...(mockWe.updateMany as jest.Mock).mock.calls,
      ...(mockWe.update as jest.Mock).mock.calls,
    ];
    expect(writes.length).toBeGreaterThan(0); // otherwise the loop proves nothing
    for (const call of writes as unknown[][]) {
      const { where, data } = writeOf(call);
      expect(data.receivedAt).toBeUndefined();
      expect(where.receivedAt).toBeUndefined();
    }
  });

  it("bumps the attempts counter, so a churning row is observable (#1829)", async () => {
    const ev = stuckRow();
    mockWe.findMany.mockResolvedValue([ev]);
    mockProcess.mockResolvedValue(undefined);
    mockWe.findUnique.mockResolvedValue({ error: null, processed: true });

    await sweepStuckWebhookEvents({ staleMinutes: 6 });

    const bump = (mockWe.update as jest.Mock).mock.calls
      .map((c: unknown[]) => writeOf(c).data)
      .find((d) => d && "attempts" in d);
    expect(bump).toEqual({ attempts: { increment: 1 } });
  });

  it("re-drives a stuck event and reconstructs the full envelope", async () => {
    mockWe.findMany.mockResolvedValue([stuckRow()]);
    mockProcess.mockResolvedValue(undefined);
    mockWe.findUnique.mockResolvedValue({ error: null, processed: true });

    const r = await sweepStuckWebhookEvents({ staleMinutes: 6 });

    expect(r).toMatchObject({ scanned: 1, recovered: 1, stillFailing: 0 });

    // Razorpay only, and BOTH stuck shapes.
    //
    // The selector used to be `processed: false, error: null` — "crashed before
    // we recorded anything". That silently excluded every handler that failed
    // loudly: markWebhookEventProcessed stamps `processed=true, error!=null` in
    // the dispatch's finally, Razorpay already got its 200 and will not
    // redeliver, so nothing on earth re-drove those rows. A transient failure
    // inside handleRefundCreated meant the gateway had refunded the customer
    // and the platform kept no record of it at all.
    const where = mockWe.findMany.mock.calls[0][0].where;
    // #1134 P1-2 — Stream joined the sweep. Its route acknowledges before
    // processing (a 15-second total retry budget that a cold instance cannot
    // fit), so a failed Stream handler has no redelivery to rescue it and this
    // is the only thing that will re-drive it.
    expect(where).toMatchObject({ provider: { in: ["razorpay", "stream"] } });
    expect(where.OR).toEqual([
      { processed: false, error: null },
      expect.objectContaining({ error: { not: null } }),
    ]);
    // The errored branch is age-bounded so a deterministically-failing row
    // retries for a week and then stops rather than churning forever.
    expect(where.OR[1].receivedAt).toHaveProperty("gte");
    // envelope reconstruction supplies the fields the schemas demand
    const [env, evType, evId] = mockProcess.mock.calls[0];
    expect(env).toMatchObject({
      entity: "event",
      event: "payment.captured",
      contains: ["payment"], // top-level payload keys
      payload: { payment: { entity: { id: "pay_1" } } },
    });
    expect(typeof env.account_id).toBe("string");
    expect(typeof env.created_at).toBe("number");
    expect(evType).toBe("payment.captured");
    expect(evId).toBe("payment.captured:pay_1");
  });

  it("a re-drive that still errors counts as stillFailing, not recovered", async () => {
    mockWe.findMany.mockResolvedValue([stuckRow()]);
    mockProcess.mockResolvedValue(undefined);
    mockWe.findUnique.mockResolvedValue({
      error: "handler boom",
      processed: true,
    });

    const r = await sweepStuckWebhookEvents({ staleMinutes: 6 });

    expect(r.recovered).toBe(0);
    expect(r.stillFailing).toBe(1);
    expect(r.errors[0]).toContain("handler boom");
  });

  it("a throw mid-dispatch is caught + the row force-marked (never re-swept forever)", async () => {
    mockWe.findMany.mockResolvedValue([stuckRow()]);
    mockProcess.mockRejectedValue(new Error("kaboom"));

    const r = await sweepStuckWebhookEvents({ staleMinutes: 6 });

    expect(r.stillFailing).toBe(1);
    expect(mockWe.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { eventId: "payment.captured:pay_1" },
        data: expect.objectContaining({ processed: true }),
      }),
    );
  });

  it("empty scan → no-op", async () => {
    mockWe.findMany.mockResolvedValue([]);
    const r = await sweepStuckWebhookEvents();
    expect(r).toMatchObject({ scanned: 0, recovered: 0, stillFailing: 0 });
    expect(mockProcess).not.toHaveBeenCalled();
  });

  // #813 — a defer-sentinel handler (refund-before-capture) leaves the row in
  // the same processed=false/error=null signature it started with. The sweeper
  // must NOT count that as recovered, and must NOT terminally mark it until it
  // ages past the give-up cap.
  it("a re-drive that stays deferred is counted as deferred, not recovered", async () => {
    const recent = new Date(Date.now() - 60 * 60_000); // 1h old, under the cap
    mockWe.findMany.mockResolvedValue([
      stuckRow({ eventId: "refund.created:rfnd_1", receivedAt: recent }),
    ]);
    mockProcess.mockResolvedValue(undefined);
    // dispatch deferred → it skipped the mark, row unchanged
    mockWe.findUnique.mockResolvedValue({ error: null, processed: false });

    const r = await sweepStuckWebhookEvents({ staleMinutes: 6 });

    expect(r).toMatchObject({
      scanned: 1,
      recovered: 0,
      stillFailing: 0,
      deferred: 1,
      gaveUp: 0,
    });
    // "Not terminally marked" — which used to be asserted as "no write at all".
    // That was sound while the sweeper's only write was the give-up stamp; since
    // #1829 it also bumps the attempts counter, so the bare
    // `expect(mockWe.update).not.toHaveBeenCalled()` would now fail on correct
    // behaviour. Assert the intent instead: no write carries a terminal marker.
    //
    // Getting this wrong in the other direction is worse than the test it
    // replaces — a deferred row stamped `gave up:` inside the 168h window would
    // abandon a payment that had not arrived yet, which is precisely what the
    // window exists to prevent.
    const terminalWrites = (mockWe.update as jest.Mock).mock.calls.filter(
      (c: unknown[]) => {
        const { data } = writeOf(c);
        return (
          typeof data.error === "string" && data.error.startsWith("gave up:")
        );
      },
    );
    expect(terminalWrites).toHaveLength(0);
  });

  it("a deferred event past the give-up cap is terminally marked + counted", async () => {
    const old = new Date(Date.now() - 200 * 60 * 60_000); // 200h > 168h cap
    mockWe.findMany.mockResolvedValue([
      stuckRow({ eventId: "refund.created:rfnd_2", receivedAt: old }),
    ]);
    mockProcess.mockResolvedValue(undefined);
    mockWe.findUnique.mockResolvedValue({ error: null, processed: false });

    const r = await sweepStuckWebhookEvents({ staleMinutes: 6 });

    expect(r).toMatchObject({ deferred: 0, gaveUp: 1, recovered: 0 });
    expect(mockWe.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { eventId: "refund.created:rfnd_2" },
        data: expect.objectContaining({
          processed: true,
          error: "gave up: payment never arrived",
        }),
      }),
    );
    expect(r.errors[0]).toContain("gave up");
  });
});
