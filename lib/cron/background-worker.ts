import * as Sentry from "@sentry/core";
import { NextRequest } from "next/server.js";
import type { CleanupRouteHandlers } from "@/lib/cron/cleanup-route";
import { netlifyDeploy, offProductionDeploy } from "@/lib/cron/deploy-context";
import { jobEnvironment } from "@/lib/cron/run-outcome";
import { flushJobSentry, initJobSentry } from "@/lib/observability/job-sentry";

const ERROR_LOG_MAX_CHARS = 8_000;

/** A failure the cleanup route could not record itself; best effort, never throws. */
async function recordAdapterFailure(
  job: string,
  startedAt: number,
  error: unknown,
): Promise<void> {
  try {
    const { default: prisma } = await import("@/lib/prisma");
    const now = new Date();
    await prisma.systemJobExecution.create({
      data: {
        jobId: job,
        jobName: job,
        status: "FAILED",
        startedAt: new Date(startedAt),
        endedAt: now,
        durationMs: Math.max(0, now.getTime() - startedAt),
        triggeredBy: "cron",
        errorLog: String(
          error instanceof Error ? (error.stack ?? error.message) : error,
        ).slice(0, ERROR_LOG_MAX_CHARS),
        result: {
          outcome: "failed",
          reason: "background-adapter",
          environment: jobEnvironment(),
        },
      },
      select: { id: true },
    });
  } catch (err) {
    console.warn(`[${job}] background failure record failed:`, err);
  }
}

/**
 * Runs one background job on the production deploy only. Failures are recorded
 * and logged, never thrown: a throw buys Netlify's two automatic retries.
 */
export async function runBackgroundWorker(
  job: string,
  req: Request,
  context: unknown,
  handlers: () => CleanupRouteHandlers,
): Promise<void> {
  const refusedContext = offProductionDeploy(context);
  if (refusedContext) {
    console.log(
      JSON.stringify({
        event: "background-worker-refused",
        job,
        deployContext: refusedContext,
      }),
    );
    return;
  }
  const startedAt = Date.now();
  initJobSentry();
  const deploy = netlifyDeploy(context);
  if (deploy) {
    Sentry.getGlobalScope().setTags({
      deploy_context: deploy.context,
      ...(deploy.id ? { deploy_id: deploy.id } : {}),
    });
  }
  try {
    const response = await handlers().POST(new NextRequest(req));
    const outcome = response.headers.get("x-job-outcome");
    if (outcome === "failure" || outcome === "partial_failure") {
      console.error(
        JSON.stringify({
          event: "background-worker-failed",
          job,
          status: response.status,
        }),
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "background-worker-failed",
        job,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    await recordAdapterFailure(job, startedAt, error);
  } finally {
    await flushJobSentry();
  }
}
