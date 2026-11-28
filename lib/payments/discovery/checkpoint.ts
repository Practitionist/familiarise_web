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

/** A remembered deferral is handed over again only this long after its last try. */
export const DEFERRED_RETRY_SECONDS = 6 * 60 * 60;
/** How long a deferral is kept: the webhook sweep gives a deferred event up after the same 168 hours. */
export const DEFERRED_KEEP_SECONDS = 7 * 24 * 60 * 60;
/** The most deferrals a pass remembers in its checkpoint. */
export const MAX_REMEMBERED_DEFERRALS = 100;
/** Once this many hand-overs of a run have cost a gateway read and ended deferred, no further one starts. */
export const GATEWAY_READ_DEFERRALS_PER_RUN = 5;

/**
 * Whether a hand-over that costs a gateway read may start now. "wait": the
 * handler deferred it within the retry time. "later": the run's bound of
 * deferrals is spent, so it is remembered as `due` and tried when a later run
 * reaches it. "untried": no room was left to remember it. Only "wait" is a
 * handler's deferral; the caller reports the other two as not attempted.
 */
export function gatewayReadTurn<T extends { triedAt: number }>(
  remembered: Map<string, T>,
  id: string,
  due: T,
  nowSeconds: number,
  deferralsThisRun: number,
): "try" | "wait" | "later" | "untried" {
  const prior = remembered.get(id);
  if (prior && nowSeconds - prior.triedAt < DEFERRED_RETRY_SECONDS) {
    return "wait";
  }
  if (!prior && remembered.size >= MAX_REMEMBERED_DEFERRALS) return "untried";
  if (deferralsThisRun < GATEWAY_READ_DEFERRALS_PER_RUN) return "try";
  if (!prior) remembered.set(id, due);
  return "later";
}

/** The standing-finding text for hand-overs a run never started, by the bound that stopped each. */
export function notAttemptedMessage(
  pass: "Refund" | "Dispute",
  overRunBound: number,
  noRoom: number,
): string {
  const noun = pass === "Refund" ? "refund" : "dispute";
  return `${pass} discovery: ${overRunBound + noRoom} gateway ${noun}(s) with no payment row under their capture id were not handed over in this run, so the handler has not judged them: ${overRunBound} because ${GATEWAY_READ_DEFERRALS_PER_RUN} such hand-overs had already been deferred in the run (a later run tries them), ${noRoom} because ${MAX_REMEMBERED_DEFERRALS} deferred ${noun}s are already remembered (not tried until one of those leaves)`;
}

/** The job's stored discovery position; null when none is stored or it no longer parses. */
export async function readDiscoveryState<T>(
  jobName: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
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
