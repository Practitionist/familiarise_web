/**
 * The one app, named out loud before it is written to.
 *
 * ## The shape of the hazard
 *
 * Dev, preview and production share ONE Stream app. There is no staging copy,
 * no rehearsal environment, and no second set of credentials — `STREAM_API_KEY`
 * and `STREAM_API_SECRET` in `.env` are the production ones, which is why every
 * sibling in this folder opens by warning that a dry run READS production and
 * an apply WRITES it.
 *
 * The failure that follows from that is not "a script has a bug". It is running
 * the wrong command against the right credentials: a `--apply` typed at a
 * terminal whose `.env` had been switched to a colleague's trial app, a shell
 * history entry from a different Stream organisation, an `--apply` left standing
 * in a copy-pasted runbook line that also carried `--target-app`. Nothing about
 * `--apply` itself says "and you are about to reconfigure the account that bills
 * real customers", which is exactly the sentence the operator needs.
 *
 * The two pre-existing gates do not cover it. `--routes-are-deployed` asserts a
 * fact about THIS repository's deploy, not about which Stream app the
 * credentials point at. And a script can only be re-pointed at a different app
 * by changing its environment — which is invisible from the command line, and
 * which is precisely the thing worth making visible.
 *
 * So a WRITE must name its target. Read-only invocations — a dry run, a
 * `--check` — never do, because the daily drift gate in
 * `.github/workflows/stream-calltype-drift.yml` runs them on a runner that has
 * no business asserting an app name, and because a guard on the read path would
 * train operators to pass the flag reflexively until it stopped meaning
 * anything.
 *
 * ## Why the name is checked, not merely required
 *
 * "Some non-empty value was supplied" is a check that passes on a stale
 * `STREAM_TARGET_APP=staging` left in a shell, which is the case it exists to
 * catch. So the declared name has to equal the name of the one app we ship
 * against, and a caller that can read the app can additionally hand over what
 * the credentials actually resolve to. Two independent assertions, because
 * either alone is satisfiable by accident:
 *
 *   - the declaration catches a stale or copied environment;
 *   - the live read catches credentials that are not ours, however
 *     confidently they were declared.
 *
 * ## Coverage — the audit this module is the output of
 *
 * Every mutating call in `scripts/stream/*.ts` was enumerated and this guard
 * added to the operator scripts around it:
 *
 *   updateCallType            ensure-call-type-grants.ts, ensure-call-type-settings.ts,
 *                             harden-unused-call-types.ts
 *   updateApp                 ensure-app-settings.ts
 *   updateAppSettings         ensure-webhook-subscription.ts, ensure-chat-type-grants.ts
 *   updateChannelType         ensure-chat-type-grants.ts
 *   createExternalStorage     ensure-recording-external-storage.ts
 *   deleteExternalStorage     ensure-recording-external-storage.ts
 *   updateCallMembers         backfill-call-member-role.ts
 *   deleteChannels            purge-memberless-dms.ts
 *   channel.updatePartial     backfill-channel-org.ts
 *   deleteUsers               stream-sync.ts — see below
 *
 * `stream-sync.ts` and `reconcile-orphaned-recordings.ts` are the two files in
 * this folder that are NOT operator scripts: they are library modules with no
 * `--apply`, imported by `jobs/stream/*.ts` and by an HTTP route under
 * `app/api/cleanup/`. `stream-sync.ts` does soft-delete Stream users through
 * `deleteUsers`, and it is deliberately not gated: a "name the target app out
 * loud" assertion is a human ceremony, and putting it on a daily cron means
 * either setting the variable in two runtimes (a workflow `env:` block and the
 * Netlify deployment) or a job that fails until somebody remembers — and the
 * runtime nobody remembers is the one that would have failed. Those two writes
 * are already bounded by a Redis lock, a maintenance drain and a schedule
 * narrower than anything an operator can fire by hand. What is missing there is
 * not a ceremony; it is an environment, and that is a separate piece of work.
 */
import "dotenv/config";

/**
 * The variable an operator sets to say which Stream app they are about to
 * write to. Also accepted as `--target-app <name>` on the command line, because
 * the flag is what someone types from memory mid-incident and the env var is
 * what a shell profile silently carries.
 */
export const TARGET_APP_ENV = "STREAM_TARGET_APP";

/**
 * The single Stream app dev, preview and production all resolve against.
 *
 * Read from `getApp` on 2026-09-29, against the credentials in this repository:
 * id 1366319, organisation `Practitionist`, placement gcp-us-east5.c1. The id
 * is recorded alongside it for the same reason the name is — Stream's API takes
 * a name in every write this folder makes, so the name is the thing that has to
 * match, and the id is what a human reads to confirm they are looking at the
 * right app in the dashboard when a write goes wrong.
 *
 * A change to this constant is a change of Stream organisation, and therefore a
 * change to every script in this folder, the credential set in
 * `docs/enterprise/50-operations/07-required-secrets.md`, and the webhook URL
 * in production. It is not a rename.
 */
export const PRODUCTION_APP_NAME = "Familiarise";

/** `getApp().id` for {@link PRODUCTION_APP_NAME}. Display and triage only. */
export const PRODUCTION_APP_ID = "1366319";

/** Read `--target-app <name>` out of an argv slice. `null` when absent. */
export function targetAppFromArgv(argv: readonly string[]): string | undefined {
  const at = argv.findIndex(
    (a) => a === "--target-app" || a.startsWith("--target-app="),
  );
  if (at === -1) return undefined;
  const eq = argv[at].indexOf("=");
  if (eq !== -1) return argv[at].slice(eq + 1);
  return argv[at + 1];
}

function namesMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export interface TargetGuardInput {
  /** `scripts/stream/…` filename, quoted back in the refusal. */
  script: string;
  /** Whether THIS invocation would write. Read-only runs are never gated. */
  writes: boolean;
  /** argv slice, so `--target-app` is as available as the env var. */
  argv?: readonly string[];
  /**
   * `getApp().app.name` read with the credentials in play, when the caller has
   * already got it. Skipped rather than fetched here: this module is imported by
   * scripts whose client is chat-shaped as well as video-shaped, and a guard
   * that had to open its own connection would be a second way to fail.
   */
  liveAppName?: string;
}

/**
 * Whether this invocation may proceed. Prints the refusal itself, because a
 * guard that returns false without saying what to type is a guard people work
 * around.
 */
export function requireNamedTargetApp(input: TargetGuardInput): boolean {
  if (!input.writes) return true;

  const declared =
    targetAppFromArgv(input.argv ?? []) ?? process.env[TARGET_APP_ENV];

  if (!declared || declared.trim() === "") {
    console.error(
      `\n🛑 Refusing to write.\n` +
        `\n   This script writes to a Stream app that dev, preview and PRODUCTION` +
        `\n   all share. There is no second app to rehearse on, and no way to` +
        `\n   tell from the credentials alone which one they point at.` +
        `\n\n   Name the target out loud and re-run:\n` +
        `     ${TARGET_APP_ENV}=${PRODUCTION_APP_NAME} npx tsx ${input.script} …` +
        `\n   or pass it as a flag: --target-app ${PRODUCTION_APP_NAME}` +
        `\n\n   A dry run needs none of this. Drop --apply and look first.\n`,
    );
    return false;
  }

  if (!namesMatch(declared, PRODUCTION_APP_NAME)) {
    console.error(
      `\n🛑 Refusing to write — the declared target is not our app.\n` +
        `\n   ${TARGET_APP_ENV}: ${declared}\n` +
        `\n   expected:              ${PRODUCTION_APP_NAME}` +
        `  (Stream app id ${PRODUCTION_APP_ID}, organisation Practitionist)\n` +
        `\n   Either the value is stale, or the credentials in this environment` +
        `\n   belong to another Stream organisation. Both are reasons to stop: the` +
        `\n   second one means a write here is a write to somebody else's account.\n`,
    );
    return false;
  }

  if (
    input.liveAppName !== undefined &&
    !namesMatch(input.liveAppName, PRODUCTION_APP_NAME)
  ) {
    console.error(
      `\n🛑 Refusing to write — the credentials resolve to a different app.\n` +
        `\n   declared target: ${PRODUCTION_APP_NAME}` +
        `\n   live app.name:   ${input.liveAppName}\n` +
        `\n   A correct declaration cannot save a wrong credential, and this is the` +
        `\n   half of that the declaration cannot catch. Nothing was written.\n`,
    );
    return false;
  }

  console.log(
    `   target confirmed: ${PRODUCTION_APP_NAME} (Stream app id ${PRODUCTION_APP_ID})`,
  );
  return true;
}
