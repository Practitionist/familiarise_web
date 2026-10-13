import type { Prisma } from "@prisma/client";
import { z } from "zod";

/** Who asked for a refund, as the refund paths record it; null is the expert, ops or a sweep. */
const refundInitiatorSchema = z.object({
  initiatedByUserId: z.string().nullable(),
});

/** The buyer asked for this refund, or its initiator was never recorded. */
export function refundInitiatedByBuyer(
  metadata: Prisma.JsonValue,
  buyerUserId: string,
): boolean {
  const meta = refundInitiatorSchema.safeParse(metadata);
  return !meta.success || meta.data.initiatedByUserId === buyerUserId;
}
