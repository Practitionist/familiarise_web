import { createHash } from "node:crypto";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { recordSystemEvent } from "@/lib/enterprise/system-events";

export const STANDING_FINDING_WINDOW_MS = 24 * 60 * 60 * 1000;
const STANDING_FINDING_CATEGORY = "STANDING_FINDING";
const MAX_STORED_IDS = 500;
const MAX_PRIOR_ROWS = 50;

const storedContext = z.object({ ids: z.array(z.string()) });

/**
 * Runs `report` only when `ids` holds an id not already reported under `key`
 * inside the window; the reported ids live in `SystemEvent`, so a fresh process
 * on the next tick sees them. A failed lookup reports (never swallows a fault).
 * Call it outside any `$transaction`.
 */
export async function reportStandingFinding(
  args: {
    key: string;
    ids: string[];
    message: string;
    windowMs?: number;
  },
  report: () => void,
): Promise<boolean> {
  const ids = [...new Set(args.ids)];
  if (ids.length === 0) return false;
  const prefix = `standing:${args.key}:`;
  const since = new Date(
    Date.now() - (args.windowMs ?? STANDING_FINDING_WINDOW_MS),
  );

  const prior = await prisma.systemEvent
    .findMany({
      where: {
        category: STANDING_FINDING_CATEGORY,
        correlationId: { startsWith: prefix },
        createdAt: { gte: since },
      },
      select: { context: true },
      orderBy: { createdAt: "desc" },
      take: MAX_PRIOR_ROWS,
    })
    .catch((err: unknown) => {
      console.warn(`[standing-finding] ${args.key} lookup failed:`, err);
      return null;
    });

  if (prior !== null) {
    const known = new Set<string>();
    for (const row of prior) {
      const parsed = storedContext.safeParse(row.context);
      if (parsed.success) parsed.data.ids.forEach((id) => known.add(id));
    }
    if (ids.every((id) => known.has(id))) return false;
  }

  const hash = createHash("sha256")
    // Code-unit order, not localeCompare: a dedupe key must not vary by collation.
    .update([...ids].sort((a, b) => Number(a > b) - Number(a < b)).join(","))
    .digest("hex")
    .slice(0, 16);
  await recordSystemEvent({
    category: STANDING_FINDING_CATEGORY,
    severity: "WARN",
    message: args.message,
    context: { ids: ids.slice(0, MAX_STORED_IDS) },
    correlationId: `${prefix}${hash}`,
  });
  report();
  return true;
}
