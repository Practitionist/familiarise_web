import type { z } from "zod";
import { readJobCheckpoint } from "@/lib/cron/with-cron-lock";

/** The bound that ended a discovery pass before the end of its list. */
export interface DiscoveryStoppedShort {
  bound: "pages" | "deadline";
  /** Pages handled in full before the bound. */
  pagesHandled: number;
}

/** A pass cut on this many runs in a row raises its standing finding. */
export const CUT_RUNS_BEFORE_FINDING = 2;

/** The job's stored discovery position; null when none is stored or it no longer parses. */
export async function readDiscoveryState<T>(
  jobName: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const stored = await readJobCheckpoint(jobName);
  if (!stored) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
