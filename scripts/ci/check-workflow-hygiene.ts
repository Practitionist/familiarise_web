/**
 * CI guard for `.github/workflows/` — two failure modes that are invisible at
 * runtime and therefore have to be caught at build time.
 *
 * 1. UNDECLARED SECRETS. A `${{ secrets.NAME }}` that does not exist does not
 *    error; it interpolates an empty string and the job reports success while
 *    running without a credential. That is how #677 PM-1 came back after being
 *    fixed in application code — the workflows were rewired to source Razorpay
 *    creds from `secrets.RAZORPAY_KEY_SECRET`, which has never existed. Every
 *    referenced name must appear in the manifest at
 *    docs/enterprise/50-operations/07-required-secrets.md, which is where the
 *    "what breaks without it" consequence is written down and reviewed.
 *
 * 2. START-MINUTE COLLISIONS. Simultaneous cron starts do not conflict on
 *    runtime (every job here finishes in ~60s) but they do stampede the
 *    Supavisor pool — the contention behind #932. The #709 minute map was
 *    collision-free when written and has since drifted twice.
 *
 * Pure static analysis: no network, no database, safe to run anywhere.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");
const MANIFEST = path.join(
  ROOT,
  "docs",
  "enterprise",
  "50-operations",
  "07-required-secrets.md",
);

const errors: string[] = [];

/** Strip `#` comments so a secret name mentioned in prose isn't read as a reference. */
function stripComments(yaml: string): string {
  return yaml
    .split("\n")
    .map((line) => {
      const hash = line.indexOf("#");
      if (hash === -1) return line;
      // Only treat `#` as a comment when it starts the token — avoids eating
      // `#709`-style issue refs that appear inside quoted strings.
      const before = line.slice(0, hash);
      const quotes = (before.match(/"/g) ?? []).length;
      return quotes % 2 === 1 ? line : before;
    })
    .join("\n");
}

const files = fs
  .readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

// ---------------------------------------------------------------- secrets ---

// Manifest rows look like `| \`SECRET_NAME\` | consumers | consequence |`, and a
// single cell may list several comma-separated names.
const manifest = fs.readFileSync(MANIFEST, "utf8");
const declared = new Set<string>();
for (const row of manifest.split("\n")) {
  if (!row.trimStart().startsWith("|")) continue;
  const firstCell = row.split("|")[1] ?? "";
  for (const m of firstCell.matchAll(/`([A-Z0-9_]+)`/g)) declared.add(m[1]);
}
if (declared.size === 0) {
  errors.push(
    `manifest parse failure: no secret names found in ${path.relative(ROOT, MANIFEST)}`,
  );
}

const referencedBy = new Map<string, string[]>();
for (const file of files) {
  const body = stripComments(
    fs.readFileSync(path.join(WORKFLOW_DIR, file), "utf8"),
  );
  for (const m of body.matchAll(/secrets\.([A-Z0-9_]+)/g)) {
    const list = referencedBy.get(m[1]) ?? [];
    if (!list.includes(file)) list.push(file);
    referencedBy.set(m[1], list);
  }
}

for (const [secret, workflows] of Array.from(referencedBy).sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  // GITHUB_TOKEN is injected by Actions itself and is never a repo secret.
  if (secret === "GITHUB_TOKEN") continue;
  if (!declared.has(secret)) {
    errors.push(
      `undeclared secret \`${secret}\` referenced by ${workflows.join(", ")} — ` +
        `add a row to ${path.relative(ROOT, MANIFEST)} stating what breaks without it`,
    );
  }
}

// -------------------------------------------------------------- schedules ---

/**
 * Expand the minute+hour fields of a 5-field cron into the concrete (hour,
 * minute) start times it fires at. Only the forms this fleet actually uses are
 * supported: `*`, a literal, a step expression, and `a-b/n`.
 */
function expandField(field: string, max: number): number[] {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    let lo = 0;
    let hi = max;
    if (range !== "*") {
      if (range.includes("-")) {
        const [a, b] = range.split("-").map(Number);
        lo = a;
        hi = b;
      } else {
        lo = hi = Number(range);
      }
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return Array.from(out);
}

type Start = { workflow: string; expr: string; firingsPerDay: number };
const startsAt = new Map<string, Start[]>(); // scoped "HH:MM" -> workflows

for (const file of files) {
  const body = stripComments(
    fs.readFileSync(path.join(WORKFLOW_DIR, file), "utf8"),
  );
  for (const m of body.matchAll(/-\s*cron:\s*["']([^"']+)["']/g)) {
    const expr = m[1].trim();
    const [min, hour, dom, , dow] = expr.split(/\s+/);
    // Day-scoped jobs (monthly, weekly) only collide with an every-hour job on
    // the days they actually run, which the hour+minute key already captures.
    if (!min || !hour) continue;
    const hours = expandField(hour, 23);
    const minutes = expandField(min, 59);
    const firingsPerDay = hours.length * minutes.length;
    for (const h of hours) {
      for (const mm of minutes) {
        // A job restricted to one weekday or one day-of-month is keyed with
        // that restriction so it isn't reported against every day's fleet.
        const scope =
          dom !== "*" ? `dom${dom}` : dow !== "*" ? `dow${dow}` : "daily";
        const key = `${scope} ${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
        const list = startsAt.get(key) ?? [];
        list.push({ workflow: file, expr, firingsPerDay });
        startsAt.set(key, list);
      }
    }
  }
}

// `* * * * *` fires on every minute by design and would collide with everything;
// exclude it from collision reporting but keep it visible in the summary.
const EVERY_MINUTE = new Set(
  files.filter((f) =>
    /-\s*cron:\s*["']\*\s+\*\s+\*\s+\*\s+\*["']/.test(
      fs.readFileSync(path.join(WORKFLOW_DIR, f), "utf8"),
    ),
  ),
);

// What actually matters is a *recurring* simultaneous start. Two daily jobs that
// happen to share 02:35 collide once a day and cost nothing; two hourly jobs
// sharing :17 collide 24 times a day, every day, and that is the pattern the
// #709 minute map was built to avoid. So a collision is only an error when both
// sides fire more than once a day — a rule that still catches the two hourly
// collisions this fleet had drifted into, without demanding the impossible of a
// */15 job (no four-times-hourly schedule can dodge every daily job in a fleet
// this dense).
const SUB_DAILY = 1;
const collisions = new Map<string, { slot: string; recurring: boolean }>();
for (const [slot, list] of Array.from(startsAt).sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  const contenders = list.filter((s) => !EVERY_MINUTE.has(s.workflow));
  const unique = Array.from(new Set(contenders.map((c) => c.workflow))).sort(
    (a, b) => a.localeCompare(b),
  );
  if (unique.length < 2) continue;
  const pair = unique.map((w) => w.replace(/\.ya?ml$/, "")).join(" + ");
  const recurring = contenders.every((c) => c.firingsPerDay > SUB_DAILY);
  // Keep the first slot seen for a pair, and let any recurring sighting win.
  const prior = collisions.get(pair);
  collisions.set(pair, {
    slot: prior?.slot ?? slot,
    recurring: (prior?.recurring ?? false) || recurring,
  });
}

const notes: string[] = [];
for (const [pair, { slot, recurring }] of collisions) {
  if (recurring) {
    errors.push(
      `recurring cron start collision at ${slot} — ${pair}: both fire more than ` +
        `once a day, so they start together every time. Stagger one of them.`,
    );
  } else {
    notes.push(`  once-a-day start overlap at ${slot} — ${pair} (tolerated)`);
  }
}

// ------------------------------------------------------------------ report ---

if (errors.length > 0) {
  console.error("check-workflow-hygiene: FAILED\n");
  for (const e of errors) console.error(`  - ${e}`);
  console.error(
    `\n${errors.length} problem(s) across ${files.length} workflow files.`,
  );
  process.exit(1);
}

if (notes.length > 0) {
  console.log(`check-workflow-hygiene: ${notes.length} tolerated overlap(s)`);
  for (const n of notes) console.log(n);
}
console.log(
  `check-workflow-hygiene: ok (${files.length} workflows, ` +
    `${referencedBy.size} distinct secrets, no recurring start collisions)`,
);
