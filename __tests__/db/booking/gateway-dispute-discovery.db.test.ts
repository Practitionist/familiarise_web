/**
 * Dispute discovery against real rows: a gateway dispute the database holds no
 * row for is imported by the dispute webhook's own handlers, so discovery and
 * the webhook end as one row and one hold whichever comes first. The gateway
 * list is mocked.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "./harness";

jest.mock("../../../lib/novu/service", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/novu/stage-then-attempt", () =>
  jest.requireActual("./harness-edges").noFlushMock(),
);
jest.mock("../../../lib/email/render", () => ({
  __esModule: true,
  renderEmail: async () => ({ html: "<p>rendered</p>", text: "rendered" }),
}));

const mockListDisputes = jest.fn();
jest.mock("../../../lib/payments/core/razorpay-disputes", () => ({
  ...jest.requireActual("../../../lib/payments/core/razorpay-disputes"),
  listRazorpayDisputes: (...a: unknown[]) => mockListDisputes(...a),
}));
const mockFetchPayment = jest.fn();
jest.mock("../../../lib/payments/core/razorpay", () => ({
  ...jest.requireActual("../../../lib/payments/core/razorpay"),
  getRazorpayClient: () => ({
    payments: { fetch: (...a: unknown[]) => mockFetchPayment(...a) },
  }),
  withRazorpaySdkTimeout: (_op: string, call: () => Promise<unknown>) => call(),
}));

import { handleDisputeCreated } from "../../../app/api/webhooks/utils";
import { discoverGatewayDisputes } from "../../../lib/payments/discovery/dispute-discovery";

const PRICE_PAISE = 50_000;
const never = () => false;

/** A paid ₹500 consultation five days out with one unpaid earning and its captured gateway payment id. */
async function paidConsultation() {
  const host = await seedHost();
  const buyer = await seedConsultee();
  const startsAt = futureAt(5, 9);
  const booking = await seedOneToOne(
    "consultation",
    host,
    buyer,
    { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
    {
      status: "APPROVED",
      isTentative: false,
      payment: { status: "SUCCEEDED", expiresAt: null, amount: PRICE_PAISE },
    },
  );
  const gatewayPaymentId = `pay_dbtier_${randomUUID()}`;
  const payment = await prisma.payment.update({
    where: { id: booking.payment!.id },
    data: { gatewayPaymentId },
  });
  const earning = await prisma.consultantEarnings.create({
    data: {
      consultantProfileId: host.consultantProfileId,
      paymentId: payment.id,
      grossAmount: BigInt(PRICE_PAISE),
      platformFeePaise: BigInt(10_000),
      consultantSharePaise: BigInt(40_000),
      status: "PENDING",
      holdUntil: new Date(Date.now() + 7 * 24 * HOUR_MS),
    },
  });
  return { payment, gatewayPaymentId, earningId: earning.id };
}

const listedDispute = (
  id: string,
  gatewayPaymentId: string,
  over: Record<string, unknown> = {},
) => ({
  id,
  payment_id: gatewayPaymentId,
  amount: PRICE_PAISE,
  currency: "INR",
  status: "open",
  phase: "chargeback",
  reason_code: "goods_not_received",
  respond_by: Math.floor(Date.now() / 1000) + 5 * 24 * 3600,
  amount_deducted: 0,
  ...over,
});

const disputesOf = (paymentId: string) =>
  prisma.dispute.findMany({
    where: { paymentId },
    select: { id: true, disputeId: true, status: true },
  });

const openHoldsOf = (disputeRowId: string) =>
  prisma.earningsHold.count({
    where: { reason: "DISPUTE", sourceRef: disputeRowId, releasedAt: null },
  });

const earningStatus = async (id: string) =>
  (
    await prisma.consultantEarnings.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    })
  ).status;

/** The `payment.dispute.created` delivery for the same dispute. */
const deliverCreated = (disputeId: string, gatewayPaymentId: string) =>
  handleDisputeCreated(
    disputeId,
    gatewayPaymentId,
    PRICE_PAISE,
    "INR",
    "goods_not_received",
    "open",
    Math.floor(Date.now() / 1000) + 5 * 24 * 3600,
    false,
    { phase: "chargeback", webhookEventId: `evt_dbtier_${randomUUID()}` },
  );

beforeEach(() => {
  mockListDisputes.mockReset();
  mockFetchPayment.mockReset();
});

it("imports a dispute its webhook never delivered with one hold, and the webhook arriving afterwards adds nothing", async () => {
  const { payment, gatewayPaymentId, earningId } = await paidConsultation();
  const disputeId = `disp_dbtier_${randomUUID()}`;
  mockListDisputes.mockResolvedValue([
    listedDispute(disputeId, gatewayPaymentId),
  ]);

  const first = await discoverGatewayDisputes(never);

  expect(first).toMatchObject({ listed: 1, imported: 1, errors: [] });
  const imported = await disputesOf(payment.id);
  expect(imported).toHaveLength(1);
  expect(imported[0]).toMatchObject({ disputeId, status: "NEEDS_RESPONSE" });
  expect(await earningStatus(earningId)).toBe("HELD");
  expect(await openHoldsOf(imported[0].id)).toBe(1);

  await deliverCreated(disputeId, gatewayPaymentId);
  const second = await discoverGatewayDisputes(never);

  expect(second).toMatchObject({ listed: 1, alreadyKnown: 1, imported: 0 });
  const after = await disputesOf(payment.id);
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({
    id: imported[0].id,
    status: "NEEDS_RESPONSE",
  });
  expect(await openHoldsOf(imported[0].id)).toBe(1);
});

it("leaves the row a webhook already wrote as the only row and the only hold when the list shows that dispute later", async () => {
  const { payment, gatewayPaymentId, earningId } = await paidConsultation();
  const disputeId = `disp_dbtier_${randomUUID()}`;
  await deliverCreated(disputeId, gatewayPaymentId);
  const [fromWebhook] = await disputesOf(payment.id);
  mockListDisputes.mockResolvedValue([
    listedDispute(disputeId, gatewayPaymentId),
  ]);

  const run = await discoverGatewayDisputes(never);

  expect(run).toMatchObject({ listed: 1, alreadyKnown: 1, imported: 0 });
  const rows = await disputesOf(payment.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: fromWebhook.id,
    status: "NEEDS_RESPONSE",
  });
  expect(await earningStatus(earningId)).toBe("HELD");
  expect(await openHoldsOf(fromWebhook.id)).toBe(1);
});

it("settles a dispute that was already won when first listed: the row is WON and its hold is released", async () => {
  const { payment, gatewayPaymentId, earningId } = await paidConsultation();
  const disputeId = `disp_dbtier_${randomUUID()}`;
  mockListDisputes.mockResolvedValue([
    listedDispute(disputeId, gatewayPaymentId, { status: "won" }),
  ]);

  const run = await discoverGatewayDisputes(never);

  expect(run).toMatchObject({ imported: 1, errors: [] });
  const rows = await disputesOf(payment.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ disputeId, status: "WON" });
  expect(await openHoldsOf(rows[0].id)).toBe(0);
  expect(await earningStatus(earningId)).not.toBe("HELD");
});

it("keeps a won dispute WON when the list shows it open in a later phase, and records that once across two runs", async () => {
  const { payment, gatewayPaymentId } = await paidConsultation();
  const disputeId = `disp_dbtier_${randomUUID()}`;
  await prisma.dispute.create({
    data: {
      paymentId: payment.id,
      amountPaise: BigInt(PRICE_PAISE),
      reason: "database tier",
      status: "WON",
      disputeId,
      paymentGateway: "RAZORPAY",
    },
  });
  mockListDisputes.mockResolvedValue([
    listedDispute(disputeId, gatewayPaymentId, { phase: "pre_arbitration" }),
  ]);

  const first = await discoverGatewayDisputes(never);
  await discoverGatewayDisputes(never);

  expect(first).toMatchObject({ notAdopted: 1, updated: 0, errors: [] });
  const rows = await disputesOf(payment.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ disputeId, status: "WON" });
  const recorded = await prisma.systemEvent.findMany({
    where: {
      category: "razorpay_webhook",
      correlationId: `dispute-discovery:${disputeId}:open:pre_arbitration`,
    },
    select: { severity: true },
  });
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({ severity: "ERROR" });
});

it("writes no dispute and no unlinked alert for a dispute whose payment the database does not know", async () => {
  const gatewayPaymentId = `pay_dbtier_${randomUUID()}`;
  const disputeId = `disp_dbtier_${randomUUID()}`;
  mockListDisputes.mockResolvedValue([
    listedDispute(disputeId, gatewayPaymentId),
  ]);
  mockFetchPayment.mockResolvedValue({
    id: gatewayPaymentId,
    order_id: `order_dbtier_${randomUUID()}`,
  });

  const run = await discoverGatewayDisputes(never);

  expect(run).toMatchObject({ unknownPayment: 1, imported: 0, errors: [] });
  expect(await prisma.dispute.count({ where: { disputeId } })).toBe(0);
  expect(
    await prisma.systemEvent.count({
      where: {
        category: "razorpay_webhook",
        message: { contains: disputeId },
      },
    }),
  ).toBe(0);
});
