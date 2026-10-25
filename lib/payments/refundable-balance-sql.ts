import { Prisma } from "@prisma/client";
import {
  RETURNED_REFUND_STATUSES,
  RETURNED_DISPUTE_STATUSES,
} from "./refundable-balance";

/** Query projection of the same balance, without loading a payment's history into memory. */
export function refundableBalancePaiseSql(
  paymentId: Prisma.Sql,
  grossPaise: Prisma.Sql,
): Prisma.Sql {
  return Prisma.sql`GREATEST(0, ${grossPaise} - COALESCE((
    SELECT SUM(r."amountPaise") FROM "Refund" r
    WHERE r."paymentId" = ${paymentId}
      AND r.status::text IN (${Prisma.join([...RETURNED_REFUND_STATUSES])})
  ), 0) - COALESCE((
    SELECT SUM(d."amountPaise") FROM "Dispute" d
    WHERE d."paymentId" = ${paymentId}
      AND d.status::text IN (${Prisma.join([...RETURNED_DISPUTE_STATUSES])})
  ), 0))`;
}
