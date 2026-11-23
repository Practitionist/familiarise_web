/** A job's resume cursor survives any run of finished runs that recorded none; real Postgres, disposable CI database only. */
import { randomUUID } from "node:crypto";
import prisma from "../../lib/prisma";
import { readJobCheckpoint } from "../../lib/cron/with-cron-lock";

const MIN = 60_000;
const minutesAgo = (m: number) => new Date(Date.now() - m * MIN);

function run(
  jobName: string,
  minutes: number,
  extra: { result?: object; status?: "COMPLETED" | "FAILED" | "RUNNING" } = {},
) {
  return prisma.systemJobExecution.create({
    data: {
      jobId: jobName,
      jobName,
      status: extra.status ?? "COMPLETED",
      startedAt: minutesAgo(minutes),
      endedAt: minutesAgo(minutes),
      ...(extra.result && { result: extra.result }),
    },
  });
}

it("finds the cursor behind six newer finished runs that recorded no checkpoint", async () => {
  const jobName = `checkpoint-skip-${randomUUID()}`;
  await run(jobName, 60, {
    result: { outcome: "completed", checkpoint: "c1" },
  });
  for (let i = 0; i < 6; i++) {
    await run(jobName, 50 - i, { result: { outcome: "completed" } });
  }
  // A running row's checkpoint is not a finished run's.
  await run(jobName, 1, { status: "RUNNING", result: { checkpoint: "live" } });

  await expect(readJobCheckpoint(jobName)).resolves.toBe("c1");
});

it("answers null when the newest run that recorded one wrote the JSON-null wrap marker", async () => {
  const jobName = `checkpoint-wrap-${randomUUID()}`;
  await run(jobName, 60, {
    result: { outcome: "completed", checkpoint: "c1" },
  });
  await run(jobName, 30, {
    result: { outcome: "completed", checkpoint: null },
  });
  await run(jobName, 10, { result: { outcome: "completed" } });

  await expect(readJobCheckpoint(jobName)).resolves.toBeNull();
});

it("answers null for a job with no checkpoint history", async () => {
  await expect(
    readJobCheckpoint(`checkpoint-none-${randomUUID()}`),
  ).resolves.toBeNull();
});
