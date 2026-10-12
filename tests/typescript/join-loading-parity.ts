/**
 * Join-loading parity check against the live database.
 *
 * One money read runs with relationLoadStrategy "join" and with "query", and
 * the two results must be deeply equal. The payment's earnings and legs carry
 * BigInt paise columns mapped to number by lib/prisma.ts, DateTimes and nulls,
 * and both lists are ordered, so the comparison covers money values, Date
 * precision, null handling and nested list order.
 *
 * No seeded value exceeds 2^31, so the check inserts one earnings row above it
 * inside an interactive transaction and always rolls that transaction back.
 *
 * Usage: npx tsx tests/typescript/join-loading-parity.ts
 */

import assert from "node:assert/strict";

import { toPlain } from "@/lib/data/serialize";
import prisma, { type Tx } from "@/lib/prisma";

const SHARE_ABOVE_INT4 = 3_000_000_000;
const GROSS_ABOVE_INT4 = 4_000_000_000;
const HOLD_UNTIL = new Date(Date.UTC(2031, 0, 2, 3, 4, 5, 678));

class RolledBack extends Error {}

function readPayment(
  tx: Tx,
  paymentId: string,
  relationLoadStrategy: "join" | "query",
) {
  return tx.payment.findUniqueOrThrow({
    where: { id: paymentId },
    include: {
      earnings: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: {
          payout: { select: { id: true, status: true, amount: true } },
        },
      },
      legs: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    },
    relationLoadStrategy,
  });
}

async function checkParity(tx: Tx): Promise<void> {
  const anchor = await tx.consultantEarnings.findFirst({
    where: { payment: { legs: { some: {} } } },
    orderBy: { createdAt: "desc" },
    select: { paymentId: true, consultantProfileId: true },
  });
  assert.ok(anchor, "no earnings row with payment legs to anchor the check");

  await tx.consultantEarnings.create({
    data: {
      paymentId: anchor.paymentId,
      consultantProfileId: anchor.consultantProfileId,
      role: "COLLABORATOR",
      // Outside any real cycle, so the composite unique cannot collide.
      cycleOrdinal: 2_000_000_000,
      grossAmount: GROSS_ABOVE_INT4,
      platformFeePaise: 0,
      consultantSharePaise: SHARE_ABOVE_INT4,
      holdUntil: HOLD_UNTIL,
    },
  });

  // Result-extension rows are Proxies; compare them as the plain values readers ship.
  const joined = toPlain(await readPayment(tx, anchor.paymentId, "join"));
  const queried = toPlain(await readPayment(tx, anchor.paymentId, "query"));
  assert.deepStrictEqual(joined, queried);

  const inserted = joined.earnings.find(
    (e) => e.cycleOrdinal === 2_000_000_000,
  );
  assert.ok(inserted, "inserted earnings row missing from the joined read");
  assert.strictEqual(inserted.consultantSharePaise, SHARE_ABOVE_INT4);
  assert.strictEqual(inserted.grossAmount, GROSS_ABOVE_INT4);
  assert.ok(inserted.holdUntil instanceof Date);
  assert.equal(inserted.holdUntil.getTime(), HOLD_UNTIL.getTime());
  assert.equal(inserted.payout, null);
  assert.equal(inserted.paidAt, null);
  assert.ok(joined.legs.length > 0, "anchor payment has no legs");

  console.log(
    `join/query parity holds: ${joined.earnings.length} earnings, ${joined.legs.length} legs`,
  );
  throw new RolledBack();
}

async function main(): Promise<void> {
  try {
    await prisma.$transaction(checkParity, { timeout: 20_000 });
  } catch (error) {
    if (!(error instanceof RolledBack)) throw error;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("join/query parity FAILED", error);
    process.exit(1);
  });
