/**
 * @jest-environment node
 */
import fs from "fs";
import path from "path";
import { jobNameFor, TARGETS } from "../../lib/cron/schedule";

const root = path.resolve(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, dir), {
    withFileTypes: true,
  })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const lockSources = ["lib", "scripts", "jobs", "app"]
  .flatMap(sourceFiles)
  .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
  .filter((text) => text.includes("withCronLock"));

const writesRow = (jobName: string) =>
  lockSources.some((text) => new RegExp(`["'\`]${jobName}["'\`]`).test(text));

const locksDirectly = (jobName: string) =>
  lockSources.some((text) =>
    new RegExp(`withCronLock\\(\\s*["'\`]${jobName}["'\`]`).test(text),
  );

describe("ticker target to SystemJobExecution jobName", () => {
  it.each(TARGETS.map((target) => [target]))(
    "%s resolves to a jobName its core writes, or is explicitly null",
    (target) => {
      const jobName = jobNameFor(target);
      const holds =
        jobName === null ? !locksDirectly(target) : writesRow(jobName);
      expect(holds).toBe(true);
    },
  );
});
