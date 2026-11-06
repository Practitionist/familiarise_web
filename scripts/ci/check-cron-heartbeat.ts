/**
 * Watches the workflows GitHub Actions schedules (today `db-live-drift` and
 * `security-audit`) and fails when one has stopped starting. It does NOT watch
 * runtime jobs: those run on the Netlify ticker and are watched from outside
 * Actions by `/api/health/jobs`, the ticker heartbeat and the daily ops digest.
 *
 * Sub-daily schedules alert after max(interval x 12, 6h), daily and slower after
 * interval x 3, because Actions delivers scheduled runs late and unevenly.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.join(__dirname, "..", "..");
const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");
/** A run of this check proves its own schedule fired. */
const SELF = "cron-heartbeat.yml";

const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

/** Smallest gap between consecutive firings of a 5-field cron, in ms. */
function shortestIntervalMs(expr: string): number | null {
  const [min, hour, dom, mon, dow] = expr.split(/\s+/);
  if (!min || !hour) return null;

  const step = (field: string, unitMs: number, span: number): number | null => {
    if (field === "*") return unitMs;
    const m = field.match(/^(?:\*|\d+-\d+)\/(\d+)$/);
    if (m) return Number(m[1]) * unitMs;
    if (/^\d+$/.test(field)) return span * unitMs; // fires once per span
    return null;
  };

  const minuteStep = step(min, MIN_MS, 60);
  if (minuteStep === null) return null;
  // A minute field that fires more than once an hour dominates the cadence,
  // regardless of the hour restriction: the shortest gap between two firings is
  // the minute step either way. (`13-59/30 * * * *` fires at :13 and :43 — a
  // 30-minute gap — and restricting the hour would not shorten it.)
  if (minuteStep < 60 * MIN_MS) return minuteStep;
  // Otherwise the hour field decides.
  const hourStep = step(hour, HOUR_MS, 24);
  if (hourStep === null) return null;
  if (hourStep < 24 * HOUR_MS) return hourStep;
  // Daily or slower: weekly / monthly restrictions widen it further.
  if (dow !== "*") return 7 * 24 * HOUR_MS;
  if (dom !== "*" || mon !== "*") return 31 * 24 * HOUR_MS;
  return 24 * HOUR_MS;
}

function toleranceMs(intervalMs: number): number {
  return intervalMs < 24 * HOUR_MS
    ? Math.max(intervalMs * 12, 6 * HOUR_MS)
    : intervalMs * 3;
}

function human(ms: number): string {
  if (ms < HOUR_MS) return `${Math.round(ms / MIN_MS)}m`;
  if (ms < 24 * HOUR_MS) return `${(ms / HOUR_MS).toFixed(1)}h`;
  return `${(ms / (24 * HOUR_MS)).toFixed(1)}d`;
}

const repo = process.env.GITHUB_REPOSITORY;
if (!repo) {
  console.log("check-cron-heartbeat: GITHUB_REPOSITORY unset — skipping");
  process.exit(0);
}

// `now` comes from the runner clock; a heartbeat is inherently wall-clock work.
const now = Date.now();
const stale: string[] = [];
const ok: string[] = [];
const skipped: string[] = [];

for (const file of fs
  .readdirSync(WORKFLOW_DIR)
  .filter((f) => (f.endsWith(".yml") || f.endsWith(".yaml")) && f !== SELF)) {
  const body = fs.readFileSync(path.join(WORKFLOW_DIR, file), "utf8");
  const stripped = body
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  const crons = Array.from(
    stripped.matchAll(/-\s*cron:\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?$/gm),
  ).map((m) => m[1].trim());
  if (crons.length === 0) continue;

  const intervals = crons
    .map(shortestIntervalMs)
    .filter((v): v is number => v !== null);
  if (intervals.length === 0) {
    skipped.push(`${file} (unparsed cron: ${crons.join(", ")})`);
    continue;
  }
  const interval = Math.min(...intervals);
  const tolerance = toleranceMs(interval);

  let lastRun: string | undefined;
  try {
    const out = execFileSync(
      "gh",
      [
        "api",
        `repos/${repo}/actions/workflows/${file}/runs`,
        "-X",
        "GET",
        "-f",
        "event=schedule",
        "-f",
        "per_page=1",
        "--jq",
        ".workflow_runs[0].created_at // empty",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    lastRun = out || undefined;
  } catch {
    skipped.push(`${file} (Actions API unavailable)`);
    continue;
  }

  if (!lastRun) {
    // Never run on a schedule. Newly added workflows land here legitimately.
    skipped.push(`${file} (no scheduled run on record yet)`);
    continue;
  }

  const age = now - Date.parse(lastRun);
  const headroom = (tolerance / Math.max(age, 1)).toFixed(1);
  const line = `${file.replace(/\.ya?ml$/, "")}: last scheduled run ${human(age)} ago (declared every ${human(interval)}, tolerance ${human(tolerance)}, headroom ${headroom}x)`;
  if (age > tolerance) stale.push(line);
  else ok.push(line);
}

// The full picture every run: shrinking headroom is the early warning of worse throttling.
for (const s of skipped) console.log(`  skipped ${s}`);
for (const s of ok.sort((a, b) => a.localeCompare(b))) console.log(`  ok ${s}`);

if (stale.length > 0) {
  console.error(
    `\ncheck-cron-heartbeat: FAILED — ${stale.length} workflow(s) have stopped firing:\n`,
  );
  for (const s of stale) console.error(`  - ${s}`);
  console.error(
    "\nA scheduled workflow that never starts produces no failed run. Check whether GitHub " +
      "disabled the schedules (60 days of repository inactivity does that) or the Actions " +
      "budget is spent before assuming a code fault.",
  );
  process.exitCode = 1;
} else {
  console.log(
    `check-cron-heartbeat: ok (${ok.length} Actions-scheduled workflows firing within tolerance, ${skipped.length} skipped)`,
  );
}
