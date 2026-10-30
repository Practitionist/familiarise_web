/** @jest-environment node */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { registryJobs } from "../../scripts/maintenance/generate-cron-reference";

jest.mock("../../lib/cron/cleanup-registry", () => {
  throw new Error(
    "Documentation generation must not import worker-bearing registry code",
  );
});
jest.mock("../../lib/prisma", () => {
  throw new Error("Documentation generation must not load Prisma");
});

const ROOT = path.resolve(__dirname, "../..");
const registry = fs.readFileSync(
  path.join(ROOT, "lib/cron/cleanup-registry.ts"),
  "utf8",
);

it("counts executable builder properties, ignoring marker comments and documentation examples", () => {
  const source = `
    // @cleanup-twin phantom
    /** Example: @cleanup-twin <slug> */
    export const CLEANUP_JOB_BUILDERS = {
      "auth-tokens": () => cleanupRoute({ job: "cleanup-auth-tokens", run: async () => 0 }),
    };
  `;
  expect(
    registryJobs(source, ROOT).map(({ slug, job }) => ({ slug, job })),
  ).toEqual([{ slug: "auth-tokens", job: "cleanup-auth-tokens" }]);
  expect(() =>
    registryJobs("export const CLEANUP_JOB_BUILDERS = loadJobs();", ROOT),
  ).toThrow("Cannot read");
});

it("documents every real builder", () => {
  const jobs = registryJobs(registry, ROOT);
  const document = fs.readFileSync(
    path.join(ROOT, "docs/maintenance/04-cron-jobs-reference.md"),
    "utf8",
  );
  const table = document
    .split("## Registered jobs")[1]
    .split("## Changing a job")[0];
  const keys = Array.from(
    table.matchAll(/^\| `([a-z0-9-]+)`/gm),
    (hit) => hit[1],
  );
  expect(new Set(keys)).toEqual(new Set(jobs.map((job) => job.slug)));
  expect(keys).toHaveLength(jobs.length);
  expect(document).not.toContain("Actions steps missing registry coverage");
  expect(document).toContain("tested wave design bound");
  expect(document).toContain("resumable ledger target yields on crowded slots");
  expect(document).toContain("Configured is not live-verified");
  expect(document).toContain("`send-appointment-reminders`; open;");
  expect(document).toContain("`transfer-recordings`; closed; 15 min");
});

it("keeps the generated artifact synchronized with executable sources", () => {
  const output = execFileSync(
    process.execPath,
    [
      path.join(ROOT, "node_modules/tsx/dist/cli.mjs"),
      "scripts/maintenance/generate-cron-reference.ts",
      "--check",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  expect(output).toContain("matches executable configuration");
});
