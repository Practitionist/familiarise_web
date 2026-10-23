/** @jest-environment node */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  registryJobs,
  workflowJobs,
} from "../../scripts/maintenance/generate-cron-reference";

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

it("distinguishes configured automatic steps from dispatch-only steps and keeps route aliases", () => {
  const source = `
      - name: Cleanup auth tokens
        id: cleanup-auth-tokens
        if: github.event_name == 'schedule' && github.event.schedule == '0 3 * * *'
        timeout-minutes: 5
        run: curl https://site.test/api/cleanup/auth-tokens
      - name: Manual purge
        id: purge-unverified-users
        if: github.event_name == 'workflow_dispatch'
        run: node_modules/.bin/tsx scripts/cleanup/purge-unverified-users.ts
  `;
  const rows = workflowJobs(source, "fleet.yml");
  expect(rows[0]).toMatchObject({
    id: "cleanup-auth-tokens",
    slug: "auth-tokens",
    crons: ["0 3 * * *"],
    timeout: "5",
  });
  expect(rows[1]).toMatchObject({
    core: "scripts/cleanup/purge-unverified-users.ts",
    crons: [],
  });
  expect(() =>
    workflowJobs(
      "      - name: Unknown\n        id: unknown\n        run: custom-runner\n",
      "fleet.yml",
    ),
  ).toThrow("Unsupported operational step");
});

it("documents every real builder and the four Actions-only registry gaps", () => {
  const jobs = registryJobs(registry, ROOT);
  const document = fs.readFileSync(
    path.join(ROOT, "docs/maintenance/04-cron-jobs-reference.md"),
    "utf8",
  );
  const table = document
    .split("## Registered jobs")[1]
    .split("## Actions steps missing registry coverage")[0];
  const keys = Array.from(
    table.matchAll(/^\| `([a-z0-9-]+)`/gm),
    (hit) => hit[1],
  );
  expect(new Set(keys)).toEqual(new Set(jobs.map((job) => job.slug)));
  expect(keys).toHaveLength(67);
  for (const id of [
    "prune-system-events",
    "expire-event-channels",
    "databreach-deadline-alerts",
    "consent-retention-sweeper",
  ]) {
    expect(jobs.some((job) => job.slug === id)).toBe(false);
    expect(
      document.split("## Actions steps missing registry coverage")[1],
    ).toContain(`\`${id}\``);
  }
  expect(document).toContain(
    "tested wave design bound, not a runtime dispatch cap",
  );
  expect(document).toContain("Configured is not live-verified");
  expect(document).toContain("`send-appointment-reminders`; open;");
  expect(document).toContain("`transfer-recordings`; open; 45 min");
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
