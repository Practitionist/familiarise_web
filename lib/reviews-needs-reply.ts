import "server-only";

import type { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";

/** A live review with no live reply that the consultant may still write. */
export const NEEDS_REPLY_WHERE = {
  OR: [
    { replyBody: null },
    { replyDeletedAt: { not: null }, replyRemovedBy: "AUTHOR" },
  ],
} satisfies Prisma.ConsultantReviewWhereInput;

/** Live reviews of this consultant still awaiting their reply. */
export function countReviewsNeedingReply(consultantProfileId: string) {
  return prisma.consultantReview.count({
    where: { consultantProfileId, deletedAt: null, ...NEEDS_REPLY_WHERE },
  });
}
