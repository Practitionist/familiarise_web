import { cache, version as reactVersion } from "react";
import { reportSentryMessage } from "@/lib/observability/report";

/**
 * Whether the session read in lib/auth-server.ts is actually memoized.
 *
 * The invariant
 * -------------
 * package.json pins `react: ^18.3.1`, and react@18.3.1 does NOT export
 * `cache`. Verified in this checkout, not inferred from a changelog:
 *
 *   $ node -e "const r=require('react');
 *     console.log(r.version, typeof r.cache, Object.keys(r).includes('cache'))"
 *   18.3.1 undefined false
 *
 * `react`'s own package.json exports map has no `./cache` subpath either —
 * `exports` offers only `.`, `./package.json`, `./jsx-runtime` and
 * `./jsx-dev-runtime` — so the named import resolves to `undefined` at
 * runtime rather than throwing. Inside the RSC layer it is not undefined:
 * Next aliases `react` to its own vendored React 19 there, and that build
 * does export `cache`. The function therefore works, and the memo is real,
 * in exactly the two environments that matter.
 *
 * So this module does NOT gate on React 19 being declared. It gates on
 * whether `cache` resolved to a function in the process that is running,
 * and reports when it did not. `lib/auth-server.ts` keeps the graceful
 * fallback either way — a thrown import-time error would take down every
 * route AND every scheduled job, which is strictly worse than an extra
 * session read.
 *
 * Why "extra session read" is a real incident and not a nit
 * ---------------------------------------------------------
 * Losing the memo is correct-but-slow: every guard in a render re-runs
 * Better Auth's getSession and the `customSession` Prisma enrichment behind
 * it. Production runs `PG_POOL_MAX=1`, so N guards on one page is N
 * serialised acquisitions of the single connection, and dashboard TTFB — or
 * a pool-exhaustion error — is the direct consequence. Nothing else in the
 * stack would notice: no test asserts the memo, and the rendered output is
 * byte-identical either way. That is exactly the failure class this file
 * exists to make visible.
 *
 * The two readings of "unmemoized", because the report is ambiguous
 * ---------------------------------------------------------------
 * In a one-shot process — the `jobs/**` cron entry points, `npx tsx`, any
 * Node script that transitively imports auth-server — `cache` is absent by
 * design and memoization would be meaningless: there is exactly one request
 * and nothing to dedupe against. The unmemoized reader is CORRECT there.
 *
 * In the Netlify RSC function, absent `cache` means Next's React alias
 * stopped applying, and the same event is a live defect. The report
 * therefore names both readings instead of choosing, and carries
 * `netlify: "true"|"false"` plus the resolved react version so an operator
 * can tell them apart from the Sentry event's own environment. It fires
 * once per process (module scope, not per call), so eight cron jobs produce
 * eight bounded events rather than a stream.
 */
export type SessionReadMemoization = "memoized" | "unmemoized";

const MEMOIZATION: SessionReadMemoization =
  typeof cache === "function" ? "memoized" : "unmemoized";

/**
 * Pure read of the resolved state. No reporting, no side effects — this is
 * the one a unit test or an ESLint rule can assert on synchronously, and it
 * is the same value `sessionReader()` in lib/auth-server.ts branches on, so
 * the tested value and the operational value cannot drift apart.
 */
export function readSessionMemoization(): SessionReadMemoization {
  return MEMOIZATION;
}

/** Narrow form of {@link readSessionMemoization} for boolean call sites. */
export function isSessionReadMemoized(): boolean {
  return MEMOIZATION === "memoized";
}

/**
 * Latches after the first sighting. Module state rather than a
 * call-site convention, so the "once per process" claim holds for any future
 * caller — a per-request call site would otherwise turn one bounded event
 * into one per request, which is the noise pattern that gets an alert rule
 * switched off.
 */
let reported = false;

/**
 * Report the state to Sentry, once per process. Returns it, and NEVER
 * throws.
 *
 * Called at module scope in lib/auth-server.ts so the signal arrives at
 * import time rather than at first getSession() call — a cron job that
 * imports the file and exits without ever reading a session would otherwise
 * report nothing at all, which is precisely the case that cannot be observed
 * from the rendered output.
 *
 * `expected: false` is deliberate. The cron reading is a modelled outcome
 * and would deserve `expected: true`, but the RSC reading is a genuine
 * defect, and collapsing them would put both on the same footing. Warning
 * level rather than error keeps it off the `expected:false` error budget
 * while still surfacing as its own Sentry issue — the point is to notice it
 * BEFORE the pool-exhaustion incident it predicts, not to page anyone for
 * it.
 */
export function assertSessionReadMemoized(): SessionReadMemoization {
  if (MEMOIZATION === "memoized") return MEMOIZATION;
  if (reported) return MEMOIZATION;
  reported = true;

  // Belt and braces, and not ceremony: this runs during module evaluation of
  // a file that ~every authenticated route and 8 scheduled jobs import. A
  // throw from the reporting path would convert "memoization silently off"
  // into "the app does not boot", which is the strictly worse outcome this
  // file exists to prevent.
  try {
    reportSentryMessage(
      "Session reads are NOT memoized: react exports no `cache` function in this process",
      {
        subsystem: "auth",
        op: "session-read-guard",
        expected: false,
        level: "warning",
        tags: { session_read_memoization: MEMOIZATION },
        contexts: {
          react: {
            // Which React answered. The expected healthy pair is
            // (19.x in the RSC function, 18.3.1 everywhere else); a
            // mismatch there is how a broken alias shows up in a log.
            version:
              typeof reactVersion === "string" ? reactVersion : "unknown",
            cacheType: typeof cache,
            // Discriminates the two readings above without a guess.
            netlify: process.env.NETLIFY === "true" ? "true" : "false",
            nextPhase: process.env.NEXT_PHASE ?? null,
          },
        },
      },
    );
  } catch {
    // Sighting is best-effort by construction. A failure to report must not
    // become a failure to boot.
  }

  // `warn` survives `compiler.removeConsole`'s production filter in
  // next.config.mjs, and a Netlify function log is the only place a cold
  // import that never reaches Sentry would be visible at all.
  console.warn(
    "[auth] session reads are not memoized (react `cache` is " +
      `${typeof cache}); every auth guard in a render will re-read the session.`,
  );

  return MEMOIZATION;
}
