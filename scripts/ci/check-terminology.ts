/**
 * #1554 CI guard — the scheduling vocabulary the reset retired must not come
 * back. A retired identifier in code is a bug that has already been written:
 * the model, column or route it names no longer exists, and a comment that
 * still uses it teaches the next reader the old shape.
 *
 * Whole-identifier matches only, so `Session` (Better Auth) and `session.user`
 * are never on the list and never matched by accident. The two substring
 * checks are for a Prisma delegate and a route prefix that survive as text.
 *
 * Code trees FAIL the build; docs, skills and prompts are reported and pass,
 * because prose is rewritten in its own change and a stale sentence there is
 * not a stale query.
 */
import fs from "fs";
import path from "path";

const ROOT = path.join(__dirname, "..", "..");

/** Trees whose offenders fail the build. */
const CODE_TREES = [
  "app",
  "lib",
  "components",
  "hooks",
  "utils",
  "scripts",
  "prisma",
  "types",
  "jobs",
  "actions",
  "__tests__",
  "netlify",
  "middleware.ts",
];

/** Trees scanned in WARN-ONLY mode: printed, never fatal. */
const PROSE_TREES = ["docs", ".claude/skills", "prompts"];

/** Retired identifiers, matched as whole words (`\bname\b`). */
const RETIRED_IDENTIFIERS = [
  "SlotOfAppointment",
  "slotOfAppointment",
  "slotsOfAppointment",
  "SlotOfAvailability",
  "slotOfAvailability",
  "slotsOfAvailability",
  "MeetingSession",
  "meetingSession",
  "TrialSession",
  "trialSession",
  "SlotCompletionStatus",
  "RescheduleProposedSlot",
  "releasedSlotIds",
  "SLOT_DURATION_MS",
  "SlotAllocationService",
  "SlotValidationService",
  "SlotCalculationService",
  "ProcessedSlot",
  "TSlotTiming",
  "SessionVM",
  "sessionsOf",
  "ratedSessionAt",
  "SessionType",
  "sessionTypes",
  "trialSessionPaid",
  "StreamSessionByOrg",
  "TrialSessionPayment",
  "ProposedSlotAuthor",
  "useSlotAllocation",
  "SlotPicker",
];

/** Retired text that is not a bare identifier. */
const RETIRED_SUBSTRINGS = ["prisma.feedback.", "/api/slots/"];

/**
 * Files exempt from the code-tree scan, read from a sidecar JSON list so an
 * exemption is a reviewed diff, not a code edit. EMPTY by design: the reset
 * retired the names everywhere, and an allowlist is how a retired name outlives
 * its model. The guard's own source and its jest fixture are excluded by
 * construction, not by the list.
 */
const ALLOWLIST_FILE = path.join("scripts", "ci", "terminology-allowlist.json");
const ALLOWLIST: ReadonlySet<string> = new Set(
  JSON.parse(
    fs.readFileSync(path.join(ROOT, ALLOWLIST_FILE), "utf8"),
  ) as string[],
);

const SELF = path.relative(ROOT, __filename);
/** The jest pin writes a retired name into a throwaway fixture; not an offence. */
const SELF_TEST = path.join("__tests__", "ci", "check-terminology.test.ts");
const SCANNED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".js",
  ".mjs",
  ".prisma",
  ".sql",
  ".md",
  ".yml",
  ".yaml",
  ".json",
]);
const SKIPPED_DIRS = new Set(["node_modules", ".next", "generated"]);

const IDENTIFIER_RE = new RegExp(
  `\\b(${RETIRED_IDENTIFIERS.join("|")})\\b`,
  "g",
);

export interface Offence {
  file: string;
  line: number;
  match: string;
}

function* walk(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  const stat = fs.statSync(dir);
  if (stat.isFile()) {
    yield dir;
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      yield* walk(path.join(dir, entry.name));
    } else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      yield path.join(dir, entry.name);
    }
  }
}

/** Every retired name in one file, with its line. */
export function scanFile(file: string, root: string): Offence[] {
  const rel = path.relative(root, file);
  const offences: Offence[] = [];
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((text, index) => {
    for (const m of text.matchAll(IDENTIFIER_RE)) {
      offences.push({ file: rel, line: index + 1, match: m[1] });
    }
    for (const needle of RETIRED_SUBSTRINGS) {
      if (text.includes(needle)) {
        offences.push({ file: rel, line: index + 1, match: needle });
      }
    }
  });
  return offences;
}

/** Scan a set of trees under `root`; the guard and its pin are never counted. */
export function scanTrees(trees: string[], root: string): Offence[] {
  const offences: Offence[] = [];
  for (const tree of trees) {
    for (const file of walk(path.join(root, tree))) {
      const rel = path.relative(root, file);
      if (rel === SELF || rel === SELF_TEST || ALLOWLIST.has(rel)) continue;
      offences.push(...scanFile(file, root));
    }
  }
  return offences;
}

function format(offences: Offence[]): string {
  return offences.map((o) => `  - ${o.file}:${o.line} — ${o.match}`).join("\n");
}

export function main(root: string = ROOT): number {
  const prose = scanTrees(PROSE_TREES, root);
  if (prose.length > 0) {
    console.warn(
      `check-terminology: ${prose.length} retired name(s) in prose (warn-only; docs move in their own change):\n` +
        format(prose),
    );
  }

  const code = scanTrees(CODE_TREES, root);
  if (code.length > 0) {
    console.error(
      `#1554 violation — retired scheduling vocabulary in code (${code.length}):\n` +
        format(code),
    );
    return 1;
  }
  console.log("check-terminology: ok");
  return 0;
}

if (require.main === module) {
  process.exit(main());
}
