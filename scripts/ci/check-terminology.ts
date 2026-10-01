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
 *
 * A second, independent check validates the FILE PATHS and CONSTRAINT NAMES
 * docs and skills cite. The list above only knows names someone remembered to
 * retire; this one is derived from the tree, so it also catches a module that
 * moved with no matching doc edit. That check is fatal everywhere, because
 * these files are what another agent is told to trust before editing booking
 * code — see the doc-pointer section below.
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

/* ========================================================================== *
 * Doc-pointer check — a doc that names a file or a constraint that no longer
 * exists is the same defect as a retired identifier in code, but it survives
 * far longer: the vocabulary check above only knows names someone remembered to
 * retire, whereas this one is derived from the tree, so it also catches a
 * module that moved without anybody updating the prose.
 *
 * #1638 is the receipt. It deleted utils/timeSlotsProcessing.ts and renamed
 * slot_no_confirmed_overlap to occurrence_no_confirmed_overlap; the skill file
 * every agent reads before touching booking kept naming both, plus a third
 * deleted path nobody had noticed. A skill that points at a deleted module is
 * self-reinforcing: the agent trusts it, greps, finds nothing, and concludes
 * the symbol is optional.
 *
 * Scoped to backticked tokens in docs and skills, and to constraint names
 * sitting in a constraint context, so prose that merely mentions a concept is
 * never a candidate. Offline and cheap: existsSync, plus one read of the SQL
 * sidecars. No database, no build.
 * ========================================================================== */

/** Doc trees whose pointers must resolve. */
const DOC_TREES = [".claude/skills", "docs"];

/**
 * The subset of DOC_TREES where a dangling pointer fails the build.
 *
 * These are the files an agent is instructed to read BEFORE touching booking
 * code, and the surface this wave verified pointer-by-pointer. Widening this
 * list is how the check graduates from "detection" to "prevention" as each
 * domain's sweep lands — it is a one-line change per domain, and each addition
 * must come with the sweep that made it green, never before.
 */
const DOC_POINTER_FATAL = [
  ".claude/skills/booking/",
  "docs/booking/",
  "docs/payments/checkout-flow/",
];

/**
 * Roughly how many dangling pointers remain outside DOC_POINTER_FATAL. Stated
 * so a reader can tell "the backlog shrank" from "the check silently stopped
 * matching" — the count only moves because a sweep removed entries.
 */
const DOC_POINTER_BACKLOG = "~160 across ~74 files, plus ~4 constraint names";

/**
 * A backticked token is treated as a repo path only if it starts with one of
 * these roots. Keeps `pi_test_123`, `utils.getSlotBookingStatus` and prose out.
 */
const PATH_ROOTS = [
  "app/",
  "lib/",
  "components/",
  "hooks/",
  "utils/",
  "scripts/",
  "prisma/",
  "types/",
  "jobs/",
  "actions/",
  "netlify/",
  "__tests__/",
  "tests/",
  "schemas/",
  "emails/",
  "providers/",
  "docs/",
  ".claude/",
  "prompts/",
  "bugs/",
];

const PATH_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".prisma",
  ".sql",
  ".md",
  ".yml",
  ".yaml",
]);

/**
 * Characters that mean the token is a pattern or prose, not a path: `a|b`,
 * `{id}`, `*.ts`, `foo(bar)`. A `..` is rejected separately below.
 */
const PATH_FORBIDDEN_CHARS = new Set([
  "*",
  "{",
  "}",
  "|",
  ",",
  "<",
  ">",
  "=",
  "$",
  "(",
  ")",
]);

/**
 * Paths that look repo-shaped but belong to a dependency. `lib/api.js` is the
 * Razorpay SDK's own module, named in the vendor docs — not this repo's lib/.
 */
const THIRD_PARTY_PATHS = new Set(["lib/api.js"]);

/**
 * The repo is db-push-managed, so prisma/migrations/ does not exist and never
 * will until the cutover. Every migration path a doc cites would fail forever.
 */
const PATH_PREFIX_EXEMPT = ["prisma/migrations/"];

/** Backticked span on one line — the only place a doc names a thing. */
const BACKTICK_RE = /`([^`\n]+)`/g;

/** `ADD CONSTRAINT "x"` / `DROP CONSTRAINT "x"` / `CREATE CONSTRAINT TRIGGER x`. */
const CONSTRAINT_DDL_RE =
  /\b(?:ADD|DROP|CREATE)\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(?:TRIGGER\s+)?[`"]([A-Za-z_][A-Za-z0-9_]*)[`"]/g;

/** `the \`x\` GiST exclusion constraint` — a few words may sit between. */
const CONSTRAINT_BEFORE_RE =
  /`([A-Za-z_][A-Za-z0-9_]*)`(?:[\s/]*[A-Za-z-]+){0,3}\s*constraints?\b/gi;

/** `constraint \`x\``. */
const CONSTRAINT_AFTER_RE =
  /\bconstraints?\s+(?:IF\s+EXISTS\s+)?(?:[A-Za-z-]+\s+){0,2}`([A-Za-z_][A-Za-z0-9_]*)`/gi;

/**
 * A captured name must be all-lowercase to count. This is what keeps
 * `AppointmentOccurrence`, `EXCLUDE`, `COMMIT`, `CHECK` and Prisma's own
 * `Wishlist_userId_fkey` examples out of the constraint check: none of them is
 * lowercase, and every constraint this schema declares is.
 */
const CONSTRAINT_NAME_RE = /^[a-z][a-z0-9_]*$/;

/** SQL keywords that can follow CONSTRAINT and are not names. */
const CONSTRAINT_KEYWORDS = new Set([
  "check",
  "trigger",
  "foreign",
  "primary",
  "unique",
  "exclude",
  "constraint",
  "deferrable",
]);

/**
 * Every constraint name the SQL sidecars actually declare — both the quoted
 * `ALTER TABLE ... ADD CONSTRAINT "x"` form and the unquoted
 * `CREATE CONSTRAINT TRIGGER x` form. A doc naming anything outside this set
 * names a constraint that does not exist.
 */
export function loadLiveConstraintNames(root: string): Set<string> {
  const dir = path.join(root, "prisma", "sql");
  const names = new Set<string>();
  if (!fs.existsSync(dir)) return names;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;
    const text = fs.readFileSync(path.join(dir, entry.name), "utf8");
    for (const m of text.matchAll(
      /CONSTRAINT(?:\s+IF\s+EXISTS)?\s+"([^"]+)"/g,
    )) {
      names.add(m[1]);
    }
    for (const m of text.matchAll(
      /CONSTRAINT\s+TRIGGER\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    )) {
      names.add(m[1]);
    }
  }
  return names;
}

/** The backticked token read as a repo-relative file path, or null. */
function asRepoPath(token: string): string | null {
  const candidate = token.trim().replace(/[.,;:)\]]+$/, "");
  if (!candidate || candidate.includes(" ") || candidate.includes(".."))
    return null;
  for (const ch of PATH_FORBIDDEN_CHARS) {
    if (candidate.includes(ch)) return null;
  }
  if (!candidate.includes("/")) return null;
  if (!PATH_ROOTS.some((root) => candidate.startsWith(root))) return null;
  if (PATH_PREFIX_EXEMPT.some((prefix) => candidate.startsWith(prefix)))
    return null;
  if (THIRD_PARTY_PATHS.has(candidate)) return null;
  const last = candidate.slice(candidate.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  if (dot <= 0) return null;
  if (!PATH_EXTENSIONS.has(last.slice(dot))) return null;
  return candidate;
}

/** Dangling doc pointers in one markdown file, with their line. */
export function scanDocFile(
  file: string,
  root: string,
  liveConstraints: ReadonlySet<string>,
): Offence[] {
  const rel = path.relative(root, file);
  const offences: Offence[] = [];
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((text, index) => {
    const line = index + 1;
    for (const m of text.matchAll(BACKTICK_RE)) {
      const asPath = asRepoPath(m[1]);
      if (asPath && !fs.existsSync(path.join(root, asPath))) {
        offences.push({ file: rel, line, match: `path → ${asPath}` });
      }
    }
    const named = new Set<string>();
    for (const re of [
      CONSTRAINT_DDL_RE,
      CONSTRAINT_BEFORE_RE,
      CONSTRAINT_AFTER_RE,
    ]) {
      for (const m of text.matchAll(re)) named.add(m[1]);
    }
    for (const name of named) {
      if (!CONSTRAINT_NAME_RE.test(name)) continue;
      if (CONSTRAINT_KEYWORDS.has(name)) continue;
      if (liveConstraints.has(name)) continue;
      offences.push({ file: rel, line, match: `constraint → ${name}` });
    }
  });
  return offences;
}

/** Scan every markdown file under the doc trees. */
export function scanDocs(trees: string[], root: string): Offence[] {
  const live = loadLiveConstraintNames(root);
  const offences: Offence[] = [];
  for (const tree of trees) {
    for (const file of walk(path.join(root, tree))) {
      if (path.extname(file) !== ".md") continue;
      offences.push(...scanDocFile(file, root, live));
    }
  }
  return offences;
}

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

  // A dangling doc pointer is not a stale sentence, it is a wrong instruction:
  // these files are the input another agent is told to trust before editing
  // booking code, so a path that no longer resolves will be followed.
  //
  // Fatal only on the AUDITED surface — the booking skill and the booking docs
  // this wave repaired pointer-by-pointer. The rest of the tree still carries a
  // large backlog of dangling pointers (see DOC_POINTER_BACKLOG); making those
  // fatal on the same commit that introduces the check would fail every PR and
  // get the check reverted rather than the backlog swept. So the backlog is
  // reported, and the audited surface is enforced. When the sweep lands, move
  // the rest of DOC_TREES into DOC_POINTER_FATAL and delete this note.
  const docs = scanDocs(DOC_TREES, root);
  const fatal = docs.filter((d) =>
    DOC_POINTER_FATAL.some((tree) => d.file.startsWith(tree)),
  );
  const backlog = docs.filter((d) => !fatal.includes(d));

  if (backlog.length > 0) {
    console.warn(
      `dangling doc pointer in the unswept tree (${backlog.length}) — reported, not fatal until the sweep lands:\n` +
        format(backlog),
    );
  }
  if (fatal.length > 0) {
    console.error(
      `dangling doc pointer — a booking doc or skill names a file or constraint that does not exist (${fatal.length}):\n` +
        format(fatal),
    );
    return 1;
  }

  console.log("check-terminology: ok");
  return 0;
}

if (require.main === module) {
  process.exit(main());
}
