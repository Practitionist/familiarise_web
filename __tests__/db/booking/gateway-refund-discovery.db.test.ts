/**
 * Refund discovery against real rows: a gateway refund the database holds no
 * row for is imported by the refund webhook's own handler, so discovery and the
 * webhook end as one row whichever comes first. The gateway list is mocked.
 */
import { never, seedCapturedConsultation } from "./harness-discovery";
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { gatewayReads } from "./harness-edges";
import { handleRefundCreated } from "../../../app/api/webhooks/utils";
import { discoverGatewayRefunds } from "../../../lib/payments/discovery/refund-discovery";

const listedRefund = (
  id: string,
  gatewayPaymentId: string,
  over: Record<string, unknown> = {},
) => ({
  id,
  payment_id: gatewayPaymentId,
  amount: 20_000,
  currency: "INR",
  status: "processed",
  notes: {},
  created_at: Math.floor(Date.now() / 1000) - 600,
  ...over,
});

const refundsOf = (paymentId: string) =>
  prisma.refund.findMany({
    where: { paymentId },
    select: { id: true, refundId: true, status: true, cascadedAt: true },
  });

const deliverProcessed = (
  gatewayRefundId: string,
  orderId: string,
  gatewayPaymentId: string,
) =>
  handleRefundCreated(
    gatewayRefundId,
    orderId,
    20_000,
    "INR",
    "processed",
    gatewayPaymentId,
    {},
    true,
  );

beforeEach(() => {
  gatewayReads.listRefunds.mockReset();
  gatewayReads.fetchPayment.mockReset();
});

it("imports a refund made at the gateway once, and its webhook arriving afterwards adds nothing", async () => {
  const { payment, gatewayPaymentId } = await seedCapturedConsultation();
  const gatewayRefundId = `rfnd_dbtier_${randomUUID()}`;
  gatewayReads.listRefunds.mockResolvedValue([
    listedRefund(gatewayRefundId, gatewayPaymentId),
  ]);

  const first = await discoverGatewayRefunds(never);

  expect(first).toMatchObject({ listed: 1, imported: 1, errors: [] });
  const imported = await refundsOf(payment.id);
  expect(imported).toHaveLength(1);
  expect(imported[0]).toMatchObject({
    refundId: gatewayRefundId,
    status: "SUCCEEDED",
  });
  expect(imported[0].cascadedAt).not.toBeNull();
  const cascadedAt = imported[0].cascadedAt;

  await deliverProcessed(
    gatewayRefundId,
    payment.paymentIntent,
    gatewayPaymentId,
  );
  const second = await discoverGatewayRefunds(never);

  expect(second).toMatchObject({ listed: 1, alreadyKnown: 1, imported: 0 });
  const after = await refundsOf(payment.id);
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({ id: imported[0].id, status: "SUCCEEDED" });
  expect(after[0].cascadedAt?.getTime()).toBe(cascadedAt?.getTime());
});

it("leaves the row a webhook already wrote as the only row when the list shows that refund later", async () => {
  const { payment, gatewayPaymentId } = await seedCapturedConsultation();
  const gatewayRefundId = `rfnd_dbtier_${randomUUID()}`;
  await deliverProcessed(
    gatewayRefundId,
    payment.paymentIntent,
    gatewayPaymentId,
  );
  const [fromWebhook] = await refundsOf(payment.id);
  gatewayReads.listRefunds.mockResolvedValue([
    listedRefund(gatewayRefundId, gatewayPaymentId),
  ]);

  const run = await discoverGatewayRefunds(never);

  expect(run).toMatchObject({ listed: 1, alreadyKnown: 1, imported: 0 });
  const rows = await refundsOf(payment.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: fromWebhook.id, status: "SUCCEEDED" });
});

it("settles the app's own reservation when the listed refund names it, instead of adding a row", async () => {
  const { payment, gatewayPaymentId } = await seedCapturedConsultation();
  const reservation = await prisma.refund.create({
    data: {
      paymentId: payment.id,
      amountPaise: BigInt(20_000),
      status: "PENDING",
      refundId: `pending_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
    },
  });
  const gatewayRefundId = `rfnd_dbtier_${randomUUID()}`;
  gatewayReads.listRefunds.mockResolvedValue([
    listedRefund(gatewayRefundId, gatewayPaymentId, {
      notes: { reservationId: reservation.id },
    }),
  ]);

  const run = await discoverGatewayRefunds(never);

  expect(run).toMatchObject({ imported: 1, errors: [] });
  const rows = await refundsOf(payment.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: reservation.id,
    refundId: gatewayRefundId,
    status: "SUCCEEDED",
  });
  expect(rows[0].cascadedAt).not.toBeNull();
});

it("fails nothing: a refund the gateway lists as failed leaves its reservation PENDING", async () => {
  const { payment, gatewayPaymentId } = await seedCapturedConsultation();
  const reservation = await prisma.refund.create({
    data: {
      paymentId: payment.id,
      amountPaise: BigInt(20_000),
      status: "PENDING",
      refundId: `pending_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
    },
  });
  gatewayReads.listRefunds.mockResolvedValue([
    listedRefund(`rfnd_dbtier_${randomUUID()}`, gatewayPaymentId, {
      status: "failed",
      notes: { reservationId: reservation.id },
    }),
  ]);

  const run = await discoverGatewayRefunds(never);

  expect(run).toMatchObject({ gatewayFailed: 1, imported: 0 });
  const rows = await refundsOf(payment.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: reservation.id,
    refundId: reservation.refundId,
    status: "PENDING",
  });
});

it("writes no refund and no refusal for a refund whose payment the database does not know", async () => {
  const gatewayPaymentId = `pay_dbtier_${randomUUID()}`;
  const orderId = `order_dbtier_${randomUUID()}`;
  const gatewayRefundId = `rfnd_dbtier_${randomUUID()}`;
  gatewayReads.listRefunds.mockResolvedValue([
    listedRefund(gatewayRefundId, gatewayPaymentId),
  ]);
  gatewayReads.fetchPayment.mockResolvedValue({
    id: gatewayPaymentId,
    order_id: orderId,
    captured: true,
  });

  const run = await discoverGatewayRefunds(never);

  expect(run).toMatchObject({ unknownPayment: 1, imported: 0, errors: [] });
  expect(
    await prisma.refund.count({ where: { refundId: gatewayRefundId } }),
  ).toBe(0);
  expect(
    await prisma.systemEvent.count({
      where: { correlationId: `refund-unmatched:${gatewayRefundId}` },
    }),
  ).toBe(0);
  const findings = await prisma.systemEvent.findMany({
    where: {
      category: "STANDING_FINDING",
      correlationId: {
        startsWith:
          "standing:reconcile-pending-refunds:discovery-unknown-payment:",
      },
    },
    select: { context: true },
  });
  expect(
    findings.some((finding) =>
      JSON.stringify(finding.context).includes(gatewayRefundId),
    ),
  ).toBe(true);
});
