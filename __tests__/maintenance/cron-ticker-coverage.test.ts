/**
 * @jest-environment node
 */

/**
 * #1775 — every money- or booking-GATING cleanup twin is on the Netlify
 * ticker, or names why it is not.
 *
 * The omission this guards against is real and was documented as deliberate.
 * `docs/maintenance/04-cron-jobs-reference.md` recorded that
 * `detect-consultant-no-shows` was deliberately absent from the ticker's
 * target list, with the reasoning that the ticker "is reserved for jobs an
 * every-hundred-minute Actions delivery would otherwise leave dangerously
 * stale" — which reads as a considered decision until you notice the job it
 * excludes issues a 100% refund. A comment is not a check: it survives the
 * thing that would falsify it. This turns it into one.
 *
 * ## Why a source walk rather than an import
 *
 * The same reason `cron-lock-registry.test.ts` reads files as text: job modules
 * connect to Prisma and Redis at import time, and a registry check must not
 * need either. It also means a NEW gating job fails this test by being
 * unlisted, which is the direction that matters — the failure mode being
 * prevented is a new sweep quietly inheriting Actions' unbounded cadence.
 *
 * ## What counts as gating
 *
 * A twin is gating if its core (transitively, through `@/`-relative imports)
 * CALLS a money or booking front door. Detectors are excluded by construction
 * and that is not an oversight: `alert-orphaned-payments` and
 * `reconcile-booking-consistency` are both money-relevant and both correctly
 * off the ticker, because a finding is REPORTED rather than acted on inside a
 * window, so their cadence is a cost rather than a latency. A detector on the
 * five-minute tick would spend Upstash commands (#1792) to re-read the same
 * rows and tell nobody anything new.
 *
 * Widening {@link GATING_CALLS} is the intended maintenance: a new gating job
 * should have to be added here deliberately rather than silently escape.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const CLEANUP_DIR = path.join(ROOT, "app", "api", "cleanup");
const TICKER = path.join(ROOT, "netlify", "functions", "cron-tick.mts");

/**
 * Calls that mean "this job's outcome has money or a booking attached".
 *
 * The refund front doors are the #1506 set. The lifecycle calls are what
 * auto-complete and the invalid-appointment repair actually do: the first
 * releases an earnings hold and opens the feedback window, the second cancels
 * a booking's slots. Neither mentions "refund" at the call site a detector
 * would grep for, which is why they are named here.
 *
 * The negative lookbehind is load-bearing. `lib/booking/transitions.ts` DEFINES
 * `transitionOccurrenceCompletion`, so a plain substring test matches every
 * module that imports the barrel — which flagged the tentative-occurrence and
 * reschedule sweeps as gating purely because they import transitions, and
 * would have made this test's "gating" set meaningless. Matching a CALL rather
 * than a declaration is what makes the walk answer the question it asks.
 */
const GATING_CALLS = [
  // Money.
  "refundBookingPayment",
  "refundWholeEventPayments",
  "refundRemovedAttendeeSeat",
  "refundPaymentsForExpired",
  "stageTrialRefundedBell",
  // Booking lifecycle: decides a booking's terminal state and its money.
  "stampTrialEarningsHold",
  "transitionOccurrenceCompletion",
  "settleSubscriptionCycle",
] as const;

const GATING_CALL_RE = new RegExp(
  `(?<!function )\\b(?:${GATING_CALLS.join("|")})\\s*\\(`,
);

/** Directories a core may live in for the transitive walk to follow it. */
const CORE_DIRS = ["scripts/", "lib/"];

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Resolve an `@/` or relative TS import to a file on disk. */
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

/**
 * Whether `file`'s source, or any core it delegates to, calls a gating front
 * door. Bounded at depth 3 because the booking cores are one or two hops from
 * their route; a deeper chain is a different job's test to own.
 */
function isGating(file: string, depth = 0, seen = new Set<string>()): boolean {
  if (depth > 3 || seen.has(file)) return false;
  seen.add(file);
  const src = read(file);
  if (!src) return false;
  if (GATING_CALL_RE.test(src)) return true;
  for (const imp of src.matchAll(
    /from\s+["'](@\/[^"']+|\.\.?\/[^"']+)["']/g,
  )) {
    const resolved = resolveImport(file, imp[1]);
    if (!resolved) continue;
    const rel = path.relative(ROOT, resolved);
    if (!CORE_DIRS.some((dir) => rel.startsWith(dir))) continue;
    if (isGating(resolved, depth + 1, seen)) return true;
  }
  return false;
}

/** The target names the ticker fires, read out of its own source. */
function tickerTargets(): string[] {
  const src = read(TICKER);
  if (!src) return [];
  const block = src.match(/const TARGETS = \[([\s\S]*?)\] as const;/);
  if (!block) return [];
  return [...block[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
}

const targets = new Set(tickerTargets());

interface Twin {
  dir: string;
  job: string | null;
  gating: boolean;
}

const twins: Twin[] = fs
  .readdirSync(CLEANUP_DIR)
  .sort()
  .map((dir) => {
    const file = path.join(CLEANUP_DIR, dir, "route.ts");
    const src = read(file);
    if (!src) return null;
    return {
      dir,
      job: src.match(/job:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? null,
      gating: isGating(file),
    };
  })
  .filter((t): t is Twin => t !== null);

/**
 * Gating twins that are deliberately NOT ticker-driven, each with the reason.
 *
 * "No reason given" is not an accepted value: an entry here is a claim that
 * the job's latency does not matter, and the reason has to say what the job
 * actually gates so the next reader can disagree with it.
 */
const NOT_TICKER_DRIVEN: Record<string, string> = {
  "cleanup-invalid-appointments":
    "hourly REPAIR, not a gate: it cancels a duplicate of a booking that also exists and moves no money, so no customer is waiting on it. Its own detection window is same user + plan + identical slot times within 30 s, which means the condition is present from the instant it happens rather than ageing into urgency — so Actions' ~100-minute upper bound delays a repair nobody is waiting for. A 15-minute tick would re-scan the same rows four times an hour and spend Upstash commands (#1792) to learn nothing new.",
  "retry-moderation-enforcement":
    "not gating — this is a WALK ARTIFACT and the reason is recorded so the next reader does not have to re-derive it. The job re-drives moderation actions (ban/unban) onto Stream and touches no money, but three hops from its core it imports lib/moderation/cancel-user-engagements.ts, which does call the refund front doors. The predicate follows imports, not reachability, so a function merely being in scope reads as a call. Its own 30-minute Actions schedule is appropriate for repairing a Stream write nobody can see from the product.",
};

describe("ticker coverage for money- and booking-gating jobs (#1775)", () => {
  it("reads a non-empty target list out of the ticker", () => {
    // A parser that silently matches nothing would make every assertion below
    // vacuously true, which is the failure mode this file most needs to avoid.
    expect(targets.size).toBeGreaterThan(15);
  });

  it("extracts a job literal from every twin", () => {
    expect(twins.length).toBeGreaterThanOrEqual(40);
    expect(twins.filter((t) => !t.job).map((t) => t.dir)).toEqual([]);
  });

  it("drives every gating twin from the ticker, or names why it does not", () => {
    const uncovered = twins
      .filter((t) => t.gating && t.job && !(t.job in NOT_TICKER_DRIVEN))
      .filter((t) => !targets.has(t.dir))
      .map(
        (t) =>
          `${t.dir} → job: "${t.job}" gates money or a booking but is not a ticker target`,
      );

    expect(uncovered).toEqual([]);
  });

  it("keeps every exemption pointing at a gating twin that still exists", () => {
    // Two directions matter: a stale key hides nothing, but a key that has
    // stopped being gating means the job is on the ticker OR has quietly
    // stopped being money-relevant, and either way the exemption is now
    // claiming something untrue.
    for (const job of Object.keys(NOT_TICKER_DRIVEN)) {
      const twin = twins.find((t) => t.job === job);
      expect(twin).toBeDefined();
      expect(twin?.gating).toBe(true);
      expect(NOT_TICKER_DRIVEN[job]).not.toBe("");
    }
  });

  it("does not exempt a job the ticker already drives", () => {
    // An exemption for a ticker target is dead weight that reads as a
    // deliberate decision while doing nothing.
    const redundant = Object.keys(NOT_TICKER_DRIVEN).filter((job) => {
      const twin = twins.find((t) => t.job === job);
      return twin ? targets.has(twin.dir) : false;
    });
    expect(redundant).toEqual([]);
  });

  // The specific regression, pinned by name so it cannot be reintroduced by
  // editing a list. Both jobs were absent for the whole life of the ticker
  // while gating an earnings release and a full refund respectively.
  it("keeps the earnings release and the no-show refund on the ticker", () => {
    expect(targets.has("auto-complete-appointments")).toBe(true);
    expect(targets.has("detect-consultant-no-shows")).toBe(true);
  });
});
