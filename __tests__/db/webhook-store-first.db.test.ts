/** A stored Razorpay event keeps its raw payload when dispatch cannot read its shape; real Postgres, disposable CI database only. */
import { randomUUID } from "node:crypto";
import prisma from "../../lib/prisma";
import { logWebhookEvent } from "../../lib/webhooks/event-log";
import { processRazorpayWebhookEvent } from "../../app/api/webhooks/razorpay-dispatch";

const HOUR_MS = 3_600_000;

/** A capture whose payment entity carries no amount: no handler can read it. */
function unreadableCapture() {
  const payload = {
    payment: { entity: { id: `pay_${randomUUID()}`, order_id: "order_x" } },
  };
  return {
    payload,
    raw: {
      entity: "event",
      account_id: "acc_dbtier",
      event: "payment.captured",
      contains: ["payment"],
      created_at: 1,
      payload,
    },
  };
}

async function storeAndDispatch(receivedAt?: Date) {
  const { payload, raw } = unreadableCapture();
  const eventId = `payment.captured:${payload.payment.entity.id}:dbtier`;
  const { isNew, claim } = await logWebhookEvent(
    "razorpay",
    eventId,
    "payment.captured",
    payload,
  );
  expect(isNew).toBe(true);
  await processRazorpayWebhookEvent(
    raw,
    "payment.captured",
    eventId,
    claim,
    receivedAt,
  );
  const row = await prisma.webhookEvent.findUniqueOrThrow({
    where: { eventId },
  });
  return { row, payload };
}

it("leaves a fresh unreadable money event stored, unprocessed and retryable", async () => {
  const { row, payload } = await storeAndDispatch();

  expect(row.processed).toBe(false);
  expect(row.error).toMatch(/^schema mismatch: payment\.captured/);
  expect(row.payload).toEqual(payload);
});

it("marks it permanent once it is older than the retry window", async () => {
  const { row, payload } = await storeAndDispatch(
    new Date(Date.now() - 25 * HOUR_MS),
  );

  expect(row.processed).toBe(false);
  expect(row.error).toMatch(/^permanent: schema mismatch: payment\.captured/);
  expect(row.payload).toEqual(payload);
});
