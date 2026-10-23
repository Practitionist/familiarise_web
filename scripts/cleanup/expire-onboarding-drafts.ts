import prisma from "@/lib/prisma";
import { z } from "zod";
import { withCronLock } from "@/lib/cron/with-cron-lock";

const draftLimit = z.number().int().min(1).max(500).default(100);
const DRAFT_TTL_DAYS = 90;
const START_BUDGET_MS = 16_000;

export interface DraftExpiryOptions {
  limit?: number;
  startedAt?: number;
}

/** A renewed draft must still survive if it changes after the bounded selection. */
export async function expireOnboardingDrafts(options: DraftExpiryOptions = {}) {
  const startedAt = options.startedAt ?? Date.now();
  return withCronLock(
    "expire-onboarding-drafts",
    { failMode: "open" },
    async () => {
      const limit = draftLimit.parse(options.limit);
      const outOfTime = () => Date.now() >= startedAt + START_BUDGET_MS;
      const where = {
        updatedAt: {
          lt: new Date(Date.now() - DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000),
        },
      };
      let deleted = 0;
      if (outOfTime())
        return { success: true, deleted, hasMore: true, errors: [] };
      try {
        const rows = await prisma.onboardingDraft.findMany({
          where,
          select: { id: true },
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          take: limit,
        });
        if (outOfTime())
          return { success: true, deleted, hasMore: true, errors: [] };
        if (rows.length > 0) {
          deleted = (
            await prisma.onboardingDraft.deleteMany({
              where: { ...where, id: { in: rows.map((row) => row.id) } },
            })
          ).count;
        }
        const hasMore =
          outOfTime() ||
          Boolean(
            await prisma.onboardingDraft.findFirst({
              where,
              select: { id: true },
            }),
          );
        return { success: true, deleted, hasMore, errors: [] };
      } catch (error) {
        return {
          success: false,
          deleted,
          hasMore: true,
          errors: [error instanceof Error ? error.message : String(error)],
        };
      }
    },
  );
}
