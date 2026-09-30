/**
 * @jest-environment node
 */

/**
 * #1301 — the target-app guard, and the coverage audit it exists to make
 * possible.
 *
 * The hazard is not "a script has a bug". Dev, preview and production share ONE
 * Stream app, and `STREAM_API_KEY`/`STREAM_API_SECRET` in this repository's
 * `.env` are the production ones — which is why every sibling in
 * `scripts/stream/` opens by warning that a dry run READS production. The
 * failure that follows is running the wrong command against the right
 * credentials, and nothing in `--apply` says "and you are about to reconfigure
 * the account that bills real customers".
 *
 * The two pre-existing gates do not cover it. `--routes-are-deployed` asserts a
 * fact about THIS repository's deploy, not about which Stream app the
 * credentials point at; and a script can only be re-pointed at another app by
 * changing its environment, which is invisible from the command line.
 *
 * These cases pin three things: the predicate itself, the audit that says which
 * scripts carry it, and the deliberate decision about the two that do not.
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

import {
  PRODUCTION_APP_ID,
  PRODUCTION_APP_NAME,
  TARGET_APP_ENV,
  requireNamedTargetApp,
  targetAppFromArgv,
} from "../../scripts/stream/target-guard";

const SCRIPTS_DIR = join(process.cwd(), "scripts", "stream");

/** Every mutating Stream call this guard was added around, per target-guard.ts. */
const GUARDED = [
  "backfill-call-member-role.ts",
  "backfill-channel-org.ts",
  "ensure-app-settings.ts",
  "ensure-call-type-grants.ts",
  "ensure-call-type-settings.ts",
  "ensure-chat-type-grants.ts",
  "ensure-recording-external-storage.ts",
  "ensure-webhook-subscription.ts",
  "harden-unused-call-types.ts",
  "purge-memberless-dms.ts",
] as const;

describe("the guard predicate", () => {
  const base = { script: "scripts/stream/x.ts" };

  it("never gates a read-only invocation", () => {
    // A scheduled drift job runs with no app name and no business having one, and
    // a guard on the read path trains operators to pass the flag reflexively
    // until it stops meaning anything.
    expect(requireNamedTargetApp({ ...base, writes: false })).toBe(true);
  });

  it("refuses a write that names nothing", () => {
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    const previous = process.env[TARGET_APP_ENV];
    delete process.env[TARGET_APP_ENV];

    expect(requireNamedTargetApp({ ...base, writes: true, argv: [] })).toBe(
      false,
    );

    // The refusal has to say what to type, or people work around it.
    const said = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toContain(TARGET_APP_ENV);
    expect(said).toContain(PRODUCTION_APP_NAME);
    expect(said).toContain("--apply");

    if (previous === undefined) delete process.env[TARGET_APP_ENV];
    else process.env[TARGET_APP_ENV] = previous;
    err.mockRestore();
  });

  it("treats an empty declaration as no declaration", () => {
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    const previous = process.env[TARGET_APP_ENV];
    process.env[TARGET_APP_ENV] = "   ";

    expect(requireNamedTargetApp({ ...base, writes: true })).toBe(false);

    if (previous === undefined) delete process.env[TARGET_APP_ENV];
    else process.env[TARGET_APP_ENV] = previous;
    err.mockRestore();
  });

  it("refuses a declaration that names ANOTHER app", () => {
    // The case a "some value was supplied" check would wave through: a stale
    // `STREAM_TARGET_APP=staging` left in a shell, or a runbook line copied from
    // a different Stream organisation.
    const err = jest.spyOn(console, "error").mockImplementation(() => {});

    expect(
      requireNamedTargetApp({
        ...base,
        writes: true,
        argv: ["--target-app", "SomebodyElsesTrialApp"],
      }),
    ).toBe(false);
    expect(err.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "SomebodyElsesTrialApp",
    );

    err.mockRestore();
  });

  it("accepts the right app, whatever the casing or surrounding space", () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});

    for (const spelling of [
      PRODUCTION_APP_NAME,
      PRODUCTION_APP_NAME.toLowerCase(),
      ` ${PRODUCTION_APP_NAME} `,
    ]) {
      expect(
        requireNamedTargetApp({
          ...base,
          writes: true,
          argv: ["--target-app", spelling],
        }),
      ).toBe(true);
    }

    log.mockRestore();
  });

  it("reads the env var as well as the flag", () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    const previous = process.env[TARGET_APP_ENV];
    process.env[TARGET_APP_ENV] = PRODUCTION_APP_NAME;

    expect(requireNamedTargetApp({ ...base, writes: true })).toBe(true);

    if (previous === undefined) delete process.env[TARGET_APP_ENV];
    else process.env[TARGET_APP_ENV] = previous;
    log.mockRestore();
  });

  it("refuses when the CREDENTIALS resolve to a different app", () => {
    // The half a declaration cannot make. A correct declaration does not save a
    // wrong credential, and `STREAM_TARGET_APP` says nothing at all about which
    // organisation `STREAM_API_KEY` belongs to.
    const err = jest.spyOn(console, "error").mockImplementation(() => {});

    expect(
      requireNamedTargetApp({
        ...base,
        writes: true,
        argv: ["--target-app", PRODUCTION_APP_NAME],
        liveAppName: "Familiarise Staging",
      }),
    ).toBe(false);
    expect(err.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "credentials",
    );

    err.mockRestore();
  });

  it("accepts when the declaration AND the live app agree", () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    expect(
      requireNamedTargetApp({
        ...base,
        writes: true,
        argv: ["--target-app", PRODUCTION_APP_NAME],
        liveAppName: PRODUCTION_APP_NAME,
      }),
    ).toBe(true);
    log.mockRestore();
  });
});

describe("reading the flag", () => {
  it("accepts both spellings", () => {
    expect(targetAppFromArgv(["--target-app", "X"])).toBe("X");
    expect(targetAppFromArgv(["--target-app=X"])).toBe("X");
  });

  it("returns undefined when absent, and does not eat the next flag", () => {
    expect(targetAppFromArgv([])).toBeUndefined();
    expect(targetAppFromArgv(["--apply", "--check"])).toBeUndefined();
    // The trailing flag must survive: `--target-app --apply` is a mistake, and
    // swallowing `--apply` would turn a refusal into a silent dry run.
    expect(targetAppFromArgv(["--target-app", "--apply"])).toBe("--apply");
  });
});

describe("the recorded app identity", () => {
  it("names the app and its id, because a dashboard check needs both", () => {
    expect(PRODUCTION_APP_NAME).toBe("Familiarise");
    expect(PRODUCTION_APP_ID).toBe("1366319");
  });
});

/**
 * The audit. Every mutating script in `scripts/stream/` has to carry the guard,
 * or the gate is theatre — a new script added next month with an `--apply` and
 * no guard would be the exact failure the guard was added for, and nothing in
 * this repository would notice.
 */
describe("the coverage audit", () => {
  it("puts the guard in every mutating operator script", () => {
    for (const file of GUARDED) {
      const source = readFileSync(join(SCRIPTS_DIR, file), "utf8");
      expect({
        file,
        guarded: source.includes("requireNamedTargetApp"),
      }).toEqual({
        file,
        guarded: true,
      });
    }
  });

  it("gates the WRITE flag, not the whole script", () => {
    // A guard that also refused reads would make every script in the folder
    // unrunnable in CI, and the drift jobs are the reason most of these exist.
    // The three write flags differ per script — `--apply` everywhere except
    // backfill-channel-org (`--apply` inverted into `dryRun`) and the external
    // storage one, which also writes on `--delete`.
    for (const file of GUARDED) {
      const source = readFileSync(join(SCRIPTS_DIR, file), "utf8");
      expect(source).toMatch(/writes: [^;]*(apply|dryRun|remove|willWrite)/);
    }
  });

  it("documents why the two job modules are NOT gated", () => {
    // `stream-sync.ts` soft-deletes Stream users through `deleteUsers`, and
    // `reconcile-orphaned-recordings.ts` writes Recording rows. Neither is an
    // operator script: they have no `--apply`, and they are imported by
    // `jobs/stream/*` and by an HTTP route under `app/api/cleanup/`. A "name the
    // target out loud" assertion on a daily cron means either setting the
    // variable in two runtimes or a job that fails until somebody remembers —
    // and the runtime nobody remembers is the one that would have failed.
    const guard = readFileSync(join(SCRIPTS_DIR, "target-guard.ts"), "utf8");
    for (const name of ["stream-sync.ts", "reconcile-orphaned-recordings.ts"]) {
      expect(guard).toContain(name);
    }
    expect(guard).toContain("deleteUsers");
  });

  it("lists every mutating Stream call it was added around", () => {
    const guard = readFileSync(join(SCRIPTS_DIR, "target-guard.ts"), "utf8");
    for (const call of [
      "updateCallType",
      "updateApp",
      "updateAppSettings",
      "updateChannelType",
      "createExternalStorage",
      "deleteExternalStorage",
      "updateCallMembers",
      "deleteChannels",
      "updatePartial",
      "deleteUsers",
    ]) {
      expect(guard).toContain(call);
    }
  });

  it("has no script in the folder with an --apply and no guard", () => {
    // The catch-all. `target-guard.ts` is the only file here with no Stream
    // client in it, and it must never grow one — a guard that could write would
    // be a script nobody guards.
    const offenders = readdirSync(SCRIPTS_DIR)
      .filter((f) => f.endsWith(".ts") && f !== "target-guard.ts")
      .filter((f) => {
        const source = readFileSync(join(SCRIPTS_DIR, f), "utf8");
        const writes =
          source.includes("--apply") || source.includes("--delete");
        return writes && !source.includes("requireNamedTargetApp");
      });
    expect(offenders).toEqual([]);
  });
});

describe("the drift workflow", () => {
  const source = existsSync(
    join(process.cwd(), ".github", "workflows", "stream-calltype-drift.yml"),
  )
    ? readFileSync(
        join(
          process.cwd(),
          ".github",
          "workflows",
          "stream-calltype-drift.yml",
        ),
        "utf8",
      )
    : "";

  it("exists, and is classified for the workflow-hygiene guard", () => {
    expect(source).not.toBe("");
    const hygiene = readFileSync(
      join(process.cwd(), "scripts", "ci", "check-workflow-hygiene.ts"),
      "utf8",
    );
    expect(hygiene).toContain('"stream-calltype-drift.yml": "scheduled"');
  });

  it("runs each script in --check mode and never --apply", () => {
    for (const script of [
      "ensure-call-type-settings.ts",
      "ensure-call-type-grants.ts",
      "ensure-webhook-subscription.ts",
    ]) {
      expect(source).toContain(`${script} --check`);
    }
    // The one thing a scheduled job must never do on a shared production Stream
    // app with no rehearsal environment. Checked against the COMMANDS rather
    // than the file, because the header above explains at length why applying is
    // left to a human — and a naive substring scan would fail on its own prose.
    const commands = source
      .split("\n")
      .filter((line) => line.trimStart().startsWith("run:"))
      .join("\n");
    expect(commands).not.toContain("--apply");
    expect(commands).not.toContain("--restore");
    expect(commands).not.toContain("--target-app");
  });

  it("is path-filtered to the files that can make code and live config disagree", () => {
    for (const path of [
      "scripts/stream/ensure-call-type-settings.ts",
      "scripts/stream/ensure-call-type-grants.ts",
      "scripts/stream/target-guard.ts",
      "lib/stream/call-cid.ts",
      // The recording family the settings script restates and must never make
      // unusable. It is module-private there, so a change to the real one has to
      // be able to fail a pull request.
      "lib/stream/recording-service.ts",
    ]) {
      expect(source).toContain(path);
    }
  });

  it("skips fork pull requests rather than failing them on a missing secret", () => {
    expect(source).toContain("head.repo.full_name == github.repository");
  });

  it("does not hand production Redis credentials to a read-only job", () => {
    // `lib/stream-client` imports `lib/redis`, which throws at module scope
    // without Upstash credentials — an import-time crash class that this
    // workflow would otherwise reintroduce by existing.
    expect(source).toContain('USE_MOCK_REDIS: "true"');
  });

  it("installs without lifecycle scripts, because it holds an admin secret", () => {
    expect(source).toContain("npm ci --ignore-scripts");
  });

  it("does not set the target app, because it writes nothing", () => {
    // Naming a Stream app in order to ASK whether the app is configured would be
    // a ceremony with no meaning behind it. The guard's own module says so.
    expect(source).not.toContain(`${TARGET_APP_ENV}:`);
  });
});
