/**
 * Join-loading parity check against the live database. Read-only: it runs
 * against the shared database on every push to dev.
 *
 * One existing payment read runs with relationLoadStrategy "join" and with
 * "query", and the two results must be deeply equal. The payment's earnings,
 * their payout and its legs carry BigInt paise columns mapped to number by
 * lib/prisma.ts, DateTimes and nulls, and both lists are ordered.
 *
 * Usage: npx tsx tests/typescript/join-loading-parity.ts
 */

import assert from "node:assert/strict";

import { toPlain } from "@/lib/data/serialize";
import prisma from "@/lib/prisma";
import { moneyResultExtensions } from "@/lib/prisma-extensions";

const ABOVE_INT4 = 3_000_000_000;

function readPayment(
  paymentId: string,
  relationLoadStrategy: "join" | "query",
) {
  return prisma.payment.findUniqueOrThrow({
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

async function checkPaymentParity(): Promise<void> {
  // Prefer a payment whose earnings reached a payout, so the payout join is exercised.
  const findAnchor = (withPayout: boolean) =>
    prisma.consultantEarnings.findFirst({
      where: {
        payment: { legs: { some: {} } },
        ...(withPayout ? { payoutId: { not: null } } : {}),
      },
      orderBy: { createdAt: "desc" },
      select: { paymentId: true },
    });
  const anchor = (await findAnchor(true)) ?? (await findAnchor(false));
  if (!anchor) {
    console.log(
      "SKIP join/query parity: no earnings row whose payment has legs",
    );
    return;
  }

  // Result-extension rows are Proxies; compare them as the plain values readers ship.
  const joined = toPlain(await readPayment(anchor.paymentId, "join"));
  const queried = toPlain(await readPayment(anchor.paymentId, "query"));
  assert.deepStrictEqual(joined, queried);
  assert.ok(joined.earnings.length > 0 && joined.legs.length > 0);
  for (const earning of joined.earnings) {
    assert.strictEqual(typeof earning.consultantSharePaise, "number");
    assert.ok(earning.createdAt instanceof Date);
  }

  console.log(
    `join/query parity holds: ${joined.earnings.length} earnings, ${joined.legs.length} legs`,
  );
}

async function checkAboveInt4Mapping(): Promise<void> {
  // $queryRaw bypasses result extensions, so the DB-decoded bigint is fed to the extension's own compute.
  const [row] = await prisma.$queryRaw<
    { consultantSharePaise: bigint }[]
  >`SELECT ${ABOVE_INT4}::bigint AS "consultantSharePaise"`;
  assert.strictEqual(typeof row.consultantSharePaise, "bigint");
  const mapped =
    moneyResultExtensions.consultantEarnings.consultantSharePaise.compute(row);
  assert.strictEqual(mapped, ABOVE_INT4);
  console.log(`money mapping holds above 2^31: ${mapped}`);
}

async function main(): Promise<void> {
  await checkPaymentParity();
  await checkAboveInt4Mapping();
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("join/query parity FAILED", error);
    process.exit(1);
  });
