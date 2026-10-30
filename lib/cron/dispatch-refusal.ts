import { jobEnvironment } from "@/lib/cron/run-outcome";
import { onNetlify } from "@/lib/runtime-host";

/** A deploy that must not run this work stood down: a 409 with a stable code, a CANCELLED refused row, no Sentry event. */
export abstract class ProductionOnlyRefusal extends Error {
  readonly httpStatus = 409 as const;
  abstract readonly code: string;
  /** `result.reason` on the refused run row. */
  abstract readonly reason: string;
  constructor(
    readonly jobName: string,
    message: string,
  ) {
    super(message);
  }
}

/** A deploy other than production refused to start a background job. */
export class BackgroundDispatchRefusedError extends ProductionOnlyRefusal {
  readonly code = "BACKGROUND_DISPATCH_PRODUCTION_ONLY" as const;
  readonly reason = "background-dispatch-production-only" as const;
  constructor(jobName: string) {
    super(
      jobName,
      `${jobName} runs only on the production deploy; this deploy does not start background jobs`,
    );
    this.name = "BackgroundDispatchRefusedError";
  }
}

/** A preview or branch deploy refused to run a job against the database it shares with production. */
export class JobRunRefusedError extends ProductionOnlyRefusal {
  readonly code = "JOB_RUN_PRODUCTION_ONLY" as const;
  readonly reason = "job-run-production-only" as const;
  constructor(jobName: string) {
    super(
      jobName,
      `${jobName} runs only on the production deploy; previews and branch deploys share its database`,
    );
    this.name = "JobRunRefusedError";
  }
}

/**
 * Jobs run on production, and in a local development or test process on no
 * host; every other deploy shares production's database and refuses.
 */
export function jobsMayRunHere(): boolean {
  return (
    jobEnvironment() === "production" ||
    (process.env.NODE_ENV !== "production" && !onNetlify())
  );
}
