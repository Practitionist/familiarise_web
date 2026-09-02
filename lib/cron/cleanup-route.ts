import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";
import {
  assertNotInMaintenance,
  MaintenanceActiveError,
} from "@/lib/maintenance-cron";

/**
 * Every job under `app/api/cleanup/*` needs the same HTTP twin: a
 * CRON_SECRET bearer check, a maintenance-phase guard, structured start/finish
 * logging, and a three-way error mapping (lock held → 409, maintenance active
 * → its own status, anything else → captured + 500). Before this factory that
 * ~75-line shape was hand-copied into 40+ route files, which is what SonarCloud
 * flagged as duplication — one job's guard bug would only ever get fixed in
 * the file someone happened to be looking at. Centralizing it means the guard
 * has exactly one place to be correct, and a route only differs by the one
 * thing that is actually route-specific: what it runs and how it maps the
 * result to a status code.
 */
export function cleanupRoute<T extends object>(opts: {
  /** Job name — feeds `assertNotInMaintenance`, the Sentry logger key, and the tag. */
  job: string;
  run: (req: NextRequest) => Promise<T>;
  /** What to log on finish; defaults to the whole result. */
  summarize?: (result: T) => Record<string, unknown>;
  /** Defaults to `result.success === false ? 500 : 200`. */
  status?: (result: T) => number;
  failureMessage?: string;
  /** Extra `message` field on the 401 body, for routes that carry one. */
  unauthorizedMessage?: string;
}): {
  GET: (req: NextRequest) => Promise<NextResponse>;
  POST: (req: NextRequest) => Promise<NextResponse>;
} {
  const { job, run, summarize, status, failureMessage, unauthorizedMessage } =
    opts;

  async function handle(req: NextRequest): Promise<NextResponse> {
    try {
      const authHeader = req.headers.get("authorization");
      const cronSecret =
        process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

      if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
        console.warn(`Unauthorized ${job} attempt`);
        return NextResponse.json(
          unauthorizedMessage
            ? { error: "Unauthorized", message: unauthorizedMessage }
            : { error: "Unauthorized" },
          { status: 401 },
        );
      }
      // The cron core is shared with the jobs/** entrypoint, which exits on
      // maintenance; this HTTP twin cannot exit, so it answers 503 instead.
      await assertNotInMaintenance(job);

      console.log(`Starting ${job} via API...`);
      Sentry.logger.info(`cron:${job} started`);

      const result = await run(req);
      const summary: Record<string, unknown> = summarize
        ? summarize(result)
        : (result as Record<string, unknown>);

      console.log(`${job} completed:`, summary);
      Sentry.logger.info(`cron:${job} finished`, summary);

      const responseStatus = status
        ? status(result)
        : (result as { success?: boolean }).success === false
          ? 500
          : 200;
      return NextResponse.json(result, { status: responseStatus });
    } catch (error) {
      // #476 — concurrent invocation (schedule overlap / manual re-run)
      // skips with a 409 instead of double-running.
      if (error instanceof CronLockHeldError) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      if (error instanceof MaintenanceActiveError) {
        return NextResponse.json(
          { error: error.message, phase: error.phase },
          { status: error.httpStatus },
        );
      }
      Sentry.captureException(error, { tags: { subsystem: "cron", job } });
      console.error(`Error in ${job}:`, error);
      return NextResponse.json(
        {
          error: failureMessage ?? `Failed to run ${job}`,
          details: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      );
    }
  }

  return { GET: handle, POST: handle };
}
