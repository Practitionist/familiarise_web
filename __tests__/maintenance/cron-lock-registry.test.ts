/**
 * @jest-environment node
 */

/**
 * #1169 — the drift guard behind "every scheduled job is locked".
 *
 * PR 6 made cron locking universal by walking the fleet once and fixing what
 * it found. That audit is worthless the moment someone adds workflow number 62
 * without a lock, so this test re-derives the same walk from source on every
 * run: `.github/workflows/*.yml` → the entrypoint each one executes → the
 * `withCronLock` call in that entrypoint or in the core it delegates to.
 *
 * It reads files as text rather than importing them. Job modules connect to
 * Prisma and Redis at import time, and a registry check must not need either.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/observability/job-sentry", () => ({
  flushJobSentry: jest.fn(),
  runJob: jest.fn(),
}));

import fs from "node:fs";
import path from "node:path";

import { FINANCIAL_JOB_NAMES } from "../../lib/maintenance-cron";
import { entrypointOf } from "../fixtures/workflow-introspection";

const ROOT = path.join(__dirname, "..", "..");
const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");

/**
 * Workflows that are legitimately not wrapped in `withCronLock`. Each entry
 * names the mechanism that replaces it — "no lock" is never an accepted reason.
 */
const LOCK_EXEMPT: Record<string, string> = {
  // Two bespoke Redis locks predate withCronLock and additionally guard the
  // HTTP approval path, which withCronLock's key shape does not reach. See
  // lib/payments/payouts/payout-service.ts.
  "process-payouts.yml": "lock:payout_processing in payout-service.ts",
  "create-payout-batch.yml": "lock:payout_batch_creation in payout-service.ts",
  // The dead-man switch itself. Locking it through Redis would make the
  // watchdog depend on the infrastructure it exists to report on, and the
  // check is read-only, so a double-run costs nothing.
  "cron-heartbeat.yml": "deliberately unlocked — read-only dead-man switch",
  // Ticker-only probe: one Sentry event per run and no DB writes; a double run
  // costs one extra event and the email alert is deduped in Redis.
  "cron-tick:sentry-ingest-canary": "deliberately unlocked — vendor probe",
  // #1270 — a drift DETECTOR, not a job. It runs the operator script in
  // `--check` mode, which makes no Stream write and no database write; the
  // whole run is one `getAppSettings` read. Two concurrent reads cost one
  // extra API call, so a lock would buy nothing and would give a read-only
  // guard a hard dependency on Redis.
  "stream-webhook-drift.yml": "deliberately unlocked — read-only drift check",
  // Catalog reads only (pg_constraint/pg_enum); a double-run costs nothing.
  "db-live-drift.yml": "deliberately unlocked — read-only catalog check",
  // #1885 — Weekly supply-chain vulnerability scan (`npm audit --omit=dev`);
  // read-only lockfile audit with no database or external state mutation.
  "security-audit.yml": "deliberately unlocked — read-only npm audit check",
};

interface Row {
  workflow: string;
  entrypoint: string | null;
  jobName: string;
  lockedIn: string | null;
  failMode: string | null;
}

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Resolve a `@/` or relative TS import to a file on disk. */
function resolveImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith("."))
    base = path.resolve(path.dirname(fromFile), spec);
  else return null;

  for (const suffix of [".ts", ".tsx", "/index.ts"]) {
    if (fs.existsSync(base + suffix)) return base + suffix;
  }
  return fs.existsSync(base) && fs.statSync(base).isFile() ? base : null;
}

function findAllLocks(
  src: string | null,
): { jobName: string; failMode: string }[] {
  if (!src) return [];
  const out: { jobName: string; failMode: string }[] = [];
  const re =
    /withCronLock\(\s*["'`]([^"'`]+)["'`]\s*,\s*\{([^}]*)\}/g;
  for (const m of src.matchAll(re)) {
    const failMode = m[2].match(/failMode:\s*["']([^"']+)["']/);
    out.push({ jobName: m[1], failMode: failMode ? failMode[1] : "unparsed" });
  }
  return out;
}

function findLock(
  src: string | null,
): { jobName: string; failMode: string } | null {
  return findAllLocks(src)[0] ?? null;
}

function extractImports(src: string): string[] {
  const specs: string[] = [];
  for (const m of src.matchAll(/from\s+["'](@\/[^"']+|\.\.?\/[^"']+)["']/g)) {
    specs.push(m[1]);
  }
  for (const m of src.matchAll(
    /import\(\s*["'](@\/[^"']+|\.\.?\/[^"']+)["']\s*\)/g,
  )) {
    specs.push(m[1]);
  }
  return specs;
}

/** Parse `@cleanup-twin <slug>` blocks from `lib/cron/cleanup-registry.ts`. */
function cleanupTwinBlocks(): Map<string, string> {
  const registryFile = path.join(ROOT, "lib", "cron", "cleanup-registry.ts");
  const src = read(registryFile) ?? "";
  const out = new Map<string, string>();
  const parts = src.split(/\/\/\s*@cleanup-twin\s+([a-z0-9-]+)\s*\n/);
  for (let i = 1; i + 1 < parts.length; i += 2) {
    out.set(parts[i], parts[i + 1]);
  }
  return out;
}

/** The lock in an entry file, or in the first core under `coreDirs` it imports. */
function lockFor(
  entry: string | null,
  entryFile: string | null,
  entrySrc: string | null,
  coreDirs: RegExp,
): { lock: ReturnType<typeof findLock>; lockedIn: string | null } {
  const own = findLock(entrySrc);
  if (own || !entrySrc || !entryFile)
    return { lock: own, lockedIn: own ? entry : null };
  // One core file can host two sweeps sharing a module (the orphan
  // confirmation re-drive plus the orphan payment healer); prefer the lock
  // whose job matches the twin's own `job:` literal over the first in file.
  const expectedJob =
    entrySrc.match(/job:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? null;
  for (const spec of extractImports(entrySrc)) {
    const resolved = resolveImport(entryFile, spec);
    if (!resolved) continue;
    const rel = path.relative(ROOT, resolved);
    if (!coreDirs.test(rel) || rel.includes("with-cron-lock")) continue;
    const all = findAllLocks(read(resolved));
    if (all.length === 0) continue;
    const found =
      (expectedJob ? all.find((l) => l.jobName === expectedJob) : null) ??
      all[0];
    if (found) return { lock: found, lockedIn: rel };
  }
  return { lock: null, lockedIn: null };
}

/** The `/api/cleanup/<target>` routes netlify/functions/cron-tick.mts POSTs. */
function tickerTargets(): string[] {
  const src = read(path.join(ROOT, "netlify", "functions", "cron-tick.mts"));
  const block =
    src?.match(/const TARGETS = \[([\s\S]*?)\] as const/)?.[1] ?? "";
  return Array.from(
    block.replace(/\/\/.*$/gm, "").matchAll(/["']([a-z0-9-]+)["']/g),
    (m) => m[1],
  );
}

function buildRegistry(): Row[] {
  const rows: Row[] = [];

  for (const workflow of fs.readdirSync(WORKFLOW_DIR).sort()) {
    if (!/\.ya?ml$/.test(workflow)) continue;
    const src = read(path.join(WORKFLOW_DIR, workflow));
    if (!src || !/^\s*schedule:/m.test(src)) continue;

    const entrypoint = entrypointOf(src);
    const entryFile = entrypoint ? path.join(ROOT, entrypoint) : null;
    const entrySrc = entryFile ? read(entryFile) : null;

    // Wrapper → core: jobs/** wrappers hold the GitHub Actions plumbing and
    // delegate to a scripts/** or lib/** core, which is where the lock usually
    // lives so every entry point (Actions, HTTP, local) inherits it.
    const { lock, lockedIn } = lockFor(
      entrypoint,
      entryFile,
      entrySrc,
      /^(scripts|lib)\//,
    );

    const guard = entrySrc?.match(/abortIfMaintenance\(\s*["'`]([^"'`]+)["'`]/);
    rows.push({
      workflow,
      entrypoint,
      jobName:
        guard?.[1] ??
        lock?.jobName ??
        path.basename(entrypoint ?? workflow, ".ts"),
      lockedIn,
      failMode: lock?.failMode ?? null,
    });
  }

  // Ticker-only jobs (no YAML twin): resolved from lib/cron/cleanup-registry.ts.
  const viaYaml = new Set(rows.map((r) => r.jobName));
  const twinBlocks = cleanupTwinBlocks();
  const registryRel = path.join("lib", "cron", "cleanup-registry.ts");
  const registryFile = path.join(ROOT, registryRel);
  for (const target of tickerTargets()) {
    const entrySrc = twinBlocks.get(target) ?? null;
    const jobName =
      entrySrc?.match(/job:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? target;
    if (viaYaml.has(jobName)) continue;
    const entrypoint = `${registryRel}#${target}`;
    const { lock, lockedIn } = lockFor(
      entrypoint,
      registryFile,
      entrySrc,
      /^(scripts|lib|jobs)\//,
    );
    rows.push({
      workflow: `cron-tick:${target}`,
      entrypoint: entrySrc ? entrypoint : null,
      jobName,
      lockedIn,
      failMode: lock?.failMode ?? null,
    });
  }

  return rows;
}

const registry = buildRegistry();

describe("cron lock registry (#1169)", () => {
  it("finds the whole scheduled fleet", () => {
    // A floor, not an equality: new jobs are expected. This only catches the
    // parser silently matching nothing after a workflow-format change.
    expect(registry.length).toBeGreaterThanOrEqual(50);
  });

  it("resolves an entrypoint for every scheduled workflow", () => {
    // CLI-only scheduled checks (e.g. `npm audit`) have no `.ts` entrypoint.
    const CLI_ONLY_SCHEDULED = new Set(["security-audit.yml"]);
    const unresolved = registry
      .filter((r) => !r.entrypoint && !CLI_ONLY_SCHEDULED.has(r.workflow))
      .map((r) => r.workflow);
    expect(unresolved).toEqual([]);
  });

  it("locks every scheduled job, or names why it does not", () => {
    const unlocked = registry
      .filter((r) => !r.lockedIn && !(r.workflow in LOCK_EXEMPT))
      .map((r) => `${r.workflow} → ${r.entrypoint} (no withCronLock)`);

    // Wrap the core in withCronLock rather than adding to LOCK_EXEMPT: an
    // unlocked job double-runs whenever a schedule overlaps a manual dispatch.
    expect(unlocked).toEqual([]);
  });

  it("keeps every exemption pointing at a workflow that still exists", () => {
    const stale = Object.keys(LOCK_EXEMPT).filter(
      (wf) => !registry.some((r) => r.workflow === wf),
    );
    expect(stale).toEqual([]);
  });

  it("drops an exemption once the job grows a real lock", () => {
    const redundant = registry
      .filter((r) => r.workflow in LOCK_EXEMPT && r.lockedIn)
      .map((r) => r.workflow);
    expect(redundant).toEqual([]);
  });

  it("runs every financial job fail-closed", () => {
    // A fail-open money job keeps running while Redis is down, which is the
    // exact window in which two runners both believe they hold the lock.
    const wrong = registry
      .filter(
        (r) =>
          FINANCIAL_JOB_NAMES.has(r.jobName) &&
          !(r.workflow in LOCK_EXEMPT) &&
          r.failMode !== "closed",
      )
      .map((r) => `${r.jobName} is failMode:${r.failMode ?? "unlocked"}`);

    expect(wrong).toEqual([]);
  });

  it("parses a failMode for every lock it found", () => {
    const unparsed = registry
      .filter(
        (r) => r.lockedIn && r.failMode !== "open" && r.failMode !== "closed",
      )
      .map((r) => `${r.workflow} → ${r.failMode}`);
    expect(unparsed).toEqual([]);
  });

  it("schedules every financial job it declares", () => {
    // FINANCIAL_JOB_NAMES gates abortIfMaintenance. A name that matches no job
    // protects nothing, and is usually a rename that lost its guard.
    const orphaned = [...FINANCIAL_JOB_NAMES].filter(
      (name) => !registry.some((r) => r.jobName === name),
    );
    expect(orphaned).toEqual([]);
  });

  it("gates every refund front-door caller behind FINANCIAL_JOB_NAMES (#1506)", () => {
    // A refunding sweep that is not in the set runs straight through DEGRADED
    // maintenance, which is the exact bug #1506 fixed for the no-show and
    // expiry sweeps. Grep scripts/** for callers rather than trusting a
    // hand-maintained list, so a new refunding script fails this test instead
    // of shipping unguarded.
    const REFUND_FRONT_DOORS = [
      "refundBookingPayment(",
      "refundWholeEventPayments(",
      "refundRemovedAttendeeSeat(",
      "refundPaymentsForExpired(",
    ];
    const SCRIPTS_DIR = path.join(ROOT, "scripts");

    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith(".ts")) out.push(full);
      }
      return out;
    }

    const callers = walk(SCRIPTS_DIR).filter((file) => {
      const src = read(file);
      return !!src && REFUND_FRONT_DOORS.some((fn) => src.includes(fn));
    });

    expect(callers.length).toBeGreaterThan(0);

    const ungated = callers
      .map((file) => {
        // One module can host two sweeps (orphan confirmation re-drive plus
        // the orphan payment healer); the file passes when any of its locks
        // is a financial job, since that is the lock guarding the refund.
        const locks = findAllLocks(read(file));
        const gated = locks.some((l) => FINANCIAL_JOB_NAMES.has(l.jobName));
        return {
          file: path.relative(ROOT, file),
          jobName: locks.map((l) => l.jobName).join(",") || "none",
          gated: locks.length > 0 && gated,
        };
      })
      .filter((r) => !r.gated)
      .map((r) => `${r.file} → withCronLock("${r.jobName}")`);

    expect(ungated).toEqual([]);
  });

  it("gives every scheduled workflow a queueing concurrency group", () => {
    // #1413 — a second, redundant guard alongside withCronLock: an overlap
    // should queue behind the in-flight run at the Actions layer too, not
    // just at the Redis layer. cancel-in-progress must stay false, since
    // killing a mid-flight money job is the one thing worse than a double run.
    const missing = registry
      .map((r) => r.workflow)
      .filter((workflow) => !workflow.startsWith("cron-tick:"))
      .filter((workflow) => {
        const src = read(path.join(WORKFLOW_DIR, workflow));
        if (!src) return true;
        const hasGroup = /^concurrency:\s*\n\s*group:\s*\S+/m.test(src);
        const hasNoCancel = /cancel-in-progress:\s*false/.test(src);
        return !(hasGroup && hasNoCancel);
      });
    expect(missing).toEqual([]);
  });
});

// #1599 F-P1-03 — `assertNotInMaintenance(job)` is a stringly gate: a money
// twin under app/api/cleanup/* whose `job:` literal is not spelled exactly as
// its FINANCIAL_JOB_NAMES entry runs straight through DEGRADED. Walk the twins
// from source and check each money twin's literal against the set.
describe("cleanup twins and the DEGRADED money gate (#1599)", () => {
  const MONEY_CORE_DIRS = [
    "scripts/payments/",
    "scripts/refunds/",
    "scripts/earnings/",
    "scripts/payouts/",
    "lib/payments/",
  ];
  const REFUND_FRONT_DOORS = [
    "refundBookingPayment(",
    "refundWholeEventPayments(",
    "refundRemovedAttendeeSeat(",
    "refundPaymentsForExpired(",
  ];
  /** Money-adjacent twins that deliberately keep running in DEGRADED. */
  const NOT_FINANCIAL: Record<string, string> = {
    // Re-drives a booking confirmation from an already-settled capture and
    // moves no money; #1686 keeps it on every ticker slot for the buyer.
    "reconcile-orphaned-confirmations": "booking re-drive from settled money",
  };

  interface Twin {
    dir: string;
    job: string | null;
    money: boolean;
  }

  function buildTwins(): Twin[] {
    const registryFile = path.join(ROOT, "lib", "cron", "cleanup-registry.ts");
    const twinBlocks = cleanupTwinBlocks();
    return Array.from(twinBlocks.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dir, src]) => {
        const job = src.match(/job:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? null;
        const money = extractImports(src).some((spec) => {
          const resolved = resolveImport(registryFile, spec);
          if (!resolved) return false;
          const rel = path.relative(ROOT, resolved);
          if (MONEY_CORE_DIRS.some((d) => rel.startsWith(d))) return true;
          const core = read(resolved);
          return !!core && REFUND_FRONT_DOORS.some((fn) => core.includes(fn));
        });
        return { dir, job, money };
      });
  }

  const twins = buildTwins();

  it("extracts a job literal from every twin", () => {
    expect(twins.length).toBeGreaterThanOrEqual(40);
    expect(twins.filter((t) => !t.job).map((t) => t.dir)).toEqual([]);
  });

  it("names every money twin in FINANCIAL_JOB_NAMES, or says why not", () => {
    const ungated = twins
      .filter((t) => t.money && !(t.job && FINANCIAL_JOB_NAMES.has(t.job)))
      .filter((t) => !(t.job && NOT_FINANCIAL[t.job]))
      .map((t) => `${t.dir} → job: "${t.job}"`);
    expect(ungated).toEqual([]);
  });

  it("keeps every exemption pointing at a twin that is still money-adjacent", () => {
    for (const job of Object.keys(NOT_FINANCIAL)) {
      const twin = twins.find((t) => t.job === job);
      expect(twin?.money).toBe(true);
      expect(FINANCIAL_JOB_NAMES.has(job)).toBe(false);
    }
  });
});
