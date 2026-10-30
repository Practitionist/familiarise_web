/**
 * One buyer, two tabs, one plan:
 *  - different windows: both checkouts stay live and neither supersedes the
 *    other (the consultee key serialises them; their windows do not overlap);
 *  - the same idempotency key with a different priced input is a new attempt:
 *    the stored fingerprint refuses to replay the first order for it, while the
 *    same inputs replay it.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { futureAt, HOUR_MS, seedHost } from "./harness";
import {
  consultationCheckout,
  publishEveryHour,
  seedBuyer,
  seedConsultationPlan,
} from "./harness-host";

jest.mock("../../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: jest.fn(async () => ({
    id: `order_${randomUUID()}`,
    client_secret: null,
  })),
  cancelPaymentIntent: jest.fn(async () => undefined),
}));
jest.mock("../../../lib/compliance/dpdp", () => ({
  __esModule: true,
  checkConsent: jest.fn(async () => true),
}));
jest.mock("../../../lib/novu", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});

import { handleCheckout } from "../../../lib/payments/checkout";
import {
  checkoutRequestFingerprint,
  replayByIdempotencyKey,
} from "../../../lib/payments/operations/checkout-replay";

async function seedPlanAndBuyer() {
  const host = await seedHost();
  await publishEveryHour(host);
  const plan = await seedConsultationPlan(host, "Two-tab consultation");
  const buyer = await seedBuyer();
  return { host, plan, buyer };
}

it("two tabs on one plan with different windows both stay live", async () => {
  const { plan, buyer } = await seedPlanAndBuyer();
  const morning = futureAt(5, 9);
  const evening = new Date(morning.getTime() + 6 * HOUR_MS);

  const outcomes = await Promise.allSettled([
    handleCheckout(
      consultationCheckout(plan.id, morning, `tab-a-${randomUUID()}`),
      buyer.userId,
    ),
    handleCheckout(
      consultationCheckout(plan.id, evening, `tab-b-${randomUUID()}`),
      buyer.userId,
    ),
  ]);

  expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "fulfilled"]);
  const live = await prisma.payment.findMany({
    where: { userId: buyer.userId, paymentStatus: "PENDING" },
    select: { paymentIntent: true },
  });
  expect(new Set(live.map((p) => p.paymentIntent)).size).toBe(2);
});

it("the same key with a different window is a new attempt; the same inputs replay the first order", async () => {
  const { plan, buyer } = await seedPlanAndBuyer();
  const key = `key-${randomUUID()}`;
  const first = consultationCheckout(plan.id, futureAt(5, 11), key);
  await handleCheckout(first, buyer.userId);
  const stored = await prisma.payment.findFirstOrThrow({
    where: { userId: buyer.userId, clientIdempotencyKey: key },
  });
  expect(stored.requestFingerprint).toBe(checkoutRequestFingerprint(first));

  const moved = consultationCheckout(plan.id, futureAt(5, 15), key);
  expect(
    await replayByIdempotencyKey(
      buyer.userId,
      key,
      checkoutRequestFingerprint(moved),
    ),
  ).toBe("fingerprint-mismatch");

  const replay = await replayByIdempotencyKey(
    buyer.userId,
    key,
    checkoutRequestFingerprint(first),
  );
  expect(replay).not.toBeNull();
  expect(replay).not.toBe("fingerprint-mismatch");
  const body = await (replay as Response).json();
  expect(body).toMatchObject({
    reused: true,
    orderId: stored.paymentIntent,
    paymentId: stored.id,
  });
});
