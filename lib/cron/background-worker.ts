import * as Sentry from "@sentry/core";
import { NextRequest } from "next/server.js";
import { z } from "zod";
import {
  bearerMatches,
  type CleanupRouteHandlers,
} from "@/lib/cron/cleanup-route";
import { netlifyDeploy, offProductionDeploy } from "@/lib/cron/deploy-context";
import { jobEnvironment } from "@/lib/cron/run-outcome";
import { flushJobSentry, initJobSentry } from "@/lib/observability/job-sentry";

const ERROR_LOG_MAX_CHARS = 8_000;

const lockUnavailableBody = z.object({
  code: z.literal("CRON_LOCK_UNAVAILABLE"),
  error: z.string(),
});

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

function logRefusal(job: string, reason: string, deployContext?: string): void {
  console.log(
    JSON.stringify({
      event: "background-worker-refused",
      job,
      reason,
      ...(deployContext ? { deployContext } : {}),
    }),
  );
}

/**
 * Runs one background job on the production deploy only, and only for a POST
 * carrying the cron bearer; anything else is logged and dropped before any work.
 * Failures are recorded and logged, never thrown: a throw buys Netlify's two
 * automatic retries.
 */
export async function runBackgroundWorker(
  job: string,
  req: Request,
  context: unknown,
  handlers: () => CleanupRouteHandlers | Promise<CleanupRouteHandlers>,
): Promise<void> {
  const refusedContext = offProductionDeploy(context);
  if (refusedContext) {
    logRefusal(job, "off-production", refusedContext);
    return;
  }
  if (req.method !== "POST") {
    logRefusal(job, "method-not-allowed");
    return;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret || !bearerMatches(req.headers.get("authorization"), secret)) {
    logRefusal(job, "unauthorized");
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
    const response = await (await handlers()).POST(new NextRequest(req));
    const outcome = response.headers.get("x-job-outcome");
    if (outcome === "failure" || outcome === "partial_failure") {
      console.error(
        JSON.stringify({
          event: "background-worker-failed",
          job,
          status: response.status,
        }),
      );
      // A refused lease leaves no run row, so the ticker would never see this failure.
      const refused = lockUnavailableBody.safeParse(
        await response.json().catch(() => null),
      );
      if (refused.success) {
        await recordAdapterFailure(job, startedAt, refused.data.error);
      }
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
