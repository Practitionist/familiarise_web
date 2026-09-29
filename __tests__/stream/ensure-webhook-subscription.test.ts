/**
 * @jest-environment node
 */

/**
 * #1134 — the operator script that widens the Stream webhook subscription.
 *
 * It exists because the live app was subscribed to six of the ten event types
 * the code handles, so attendance and chat moderation shipped dead even after
 * the missing webhook secret was fixed. It is run by hand against a shared
 * production Stream app that has no rehearsal environment, which is the reason
 * these cases are pinned rather than trusted.
 *
 * The bug these guard: `updateAppSettings({ event_hooks })` REPLACES the whole
 * array. Submitting `[theOneHookIWant]` therefore deletes every other hook on
 * the app — a second webhook another integration owns, or an SQS or Pusher hook,
 * neither of which even appears in the `hook_type === "webhook"` filter. Doing
 * it inside the per-hook loop compounded it: each write was built from data read
 * before the previous write, so with two hooks to widen only the last survived.
 */

const mockGetAppSettings = jest.fn();
const mockUpdateAppSettings = jest.fn();
const mockIsStreamConfigured = jest.fn(() => true);

// The pre-image and the rollback. `node:fs` is mocked whole because a real run
// would write into `.stream-backups/`, and the rollback has to be tested against
// a pre-image this suite controls — so `existsSync` and `readFileSync` are faked
// per case rather than reaching for a temp directory.
const mockExistsSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockRenameSync = jest.fn();
const mockReadFileSync = jest.fn();
const mockMkdirSync = jest.fn();

jest.mock("node:fs", () => ({
  existsSync: (...a: unknown[]) => mockExistsSync(...a),
  writeFileSync: (...a: unknown[]) => mockWriteFileSync(...a),
  renameSync: (...a: unknown[]) => mockRenameSync(...a),
  readFileSync: (...a: unknown[]) => mockReadFileSync(...a),
  mkdirSync: (...a: unknown[]) => mockMkdirSync(...a),
}));

jest.mock("../../lib/stream-client", () => ({
  // Wrapped rather than passed directly: the factory body runs while the
  // module under test is being imported, which is before this file's `const`
  // declarations have initialised. An arrow defers the reference.
  isStreamConfigured: jest.fn(() => mockIsStreamConfigured()),
  getStreamChatClient: jest.fn(() => ({
    getAppSettings: mockGetAppSettings,
    updateAppSettings: mockUpdateAppSettings,
  })),
}));

import {
  DRIFT_EXIT_CODE,
  ensureWebhookSubscription,
} from "../../scripts/stream/ensure-webhook-subscription";
import { HANDLED_EVENT_TYPES } from "../../lib/stream/webhook-events";
import { PRODUCTION_APP_NAME } from "../../scripts/stream/target-guard";

/** `--apply` needs a named target app; see target-guard.ts. */
const APPLY = { argv: ["--target-app", PRODUCTION_APP_NAME] };

/** The live hook, subscribed to six of the ten handled types. */
const liveWebhook = {
  id: "hook_live",
  hook_type: "webhook",
  enabled: true,
  webhook_url: "https://familiarisenow.com/api/stream/webhooks",
  event_types: [
    "call.recording_started",
    "call.recording_stopped",
    "call.recording_ready",
    "call.recording_failed",
    "call.session_ended",
    "call.ended",
  ],
};

/** A hook this codebase does not own and must never destroy. */
const foreignSqsHook = {
  id: "hook_sqs",
  hook_type: "sqs",
  enabled: true,
  event_types: ["message.new"],
};

function appWith(hooks: unknown[], over: Record<string, unknown> = {}) {
  return { app: { event_hooks: hooks, name: PRODUCTION_APP_NAME, ...over } };
}

/** The event_hooks array actually submitted to Stream. */
function submitted(): {
  id: string;
  event_types?: string[];
  hook_type?: string;
  webhook_url?: string;
}[] {
  const call = mockUpdateAppSettings.mock.calls.at(-1);
  if (!call) throw new Error("updateAppSettings was never called");
  return call[0].event_hooks;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateAppSettings.mockResolvedValue({});
  mockIsStreamConfigured.mockReturnValue(true);
  // No pre-image unless a case writes one.
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockImplementation(() => {
    throw new Error("ENOENT");
  });
});

describe("ensure-webhook-subscription", () => {
  it("is a dry run by default and writes nothing", async () => {
    mockGetAppSettings.mockResolvedValue(appWith([liveWebhook]));

    const code = await ensureWebhookSubscription("dry-run");

    expect(code).toBe(0);
    expect(mockUpdateAppSettings).not.toHaveBeenCalled();
  });

  it("widens the hook to cover every handled event type", async () => {
    mockGetAppSettings.mockResolvedValue(appWith([liveWebhook]));

    await ensureWebhookSubscription("apply", APPLY);

    const hook = submitted().find((h) => h.id === "hook_live");
    for (const t of HANDLED_EVENT_TYPES) {
      expect(hook?.event_types).toContain(t);
    }
  });

  it("PRESERVES a hook it does not own", async () => {
    // The one that mattered. `hook_sqs` is filtered out of the webhook loop
    // entirely, so a payload built from that loop would not mention it — and
    // updateAppSettings replaces the array, so it would be deleted.
    mockGetAppSettings.mockResolvedValue(
      appWith([liveWebhook, foreignSqsHook]),
    );

    await ensureWebhookSubscription("apply", APPLY);

    const ids = submitted().map((h) => h.id);
    expect(ids).toContain("hook_sqs");
    expect(ids).toContain("hook_live");
    expect(submitted()).toHaveLength(2);
  });

  it("leaves the untouched hook's own event_types alone", async () => {
    mockGetAppSettings.mockResolvedValue(
      appWith([liveWebhook, foreignSqsHook]),
    );

    await ensureWebhookSubscription("apply", APPLY);

    const sqs = submitted().find((h) => h.id === "hook_sqs");
    expect(sqs?.event_types).toEqual(["message.new"]);
  });

  it("widens two webhooks in a SINGLE write, so neither clobbers the other", async () => {
    const second = { ...liveWebhook, id: "hook_second" };
    mockGetAppSettings.mockResolvedValue(appWith([liveWebhook, second]));

    await ensureWebhookSubscription("apply", APPLY);

    // One write. Per-hook writes meant the second payload was built from a read
    // taken before the first landed, so only the last hook's widening survived.
    expect(mockUpdateAppSettings).toHaveBeenCalledTimes(1);
    for (const id of ["hook_live", "hook_second"]) {
      const h = submitted().find((x) => x.id === id);
      expect(h?.event_types).toContain("call.recording_ready");
    }
  });

  it("never replaces a wildcard subscription with an explicit list", async () => {
    // A hook on "*" already receives everything; rewriting it to ten named
    // types would NARROW it.
    mockGetAppSettings.mockResolvedValue(
      appWith([{ ...liveWebhook, event_types: ["*"] }]),
    );

    const code = await ensureWebhookSubscription("apply", APPLY);

    expect(code).toBe(0);
    expect(mockUpdateAppSettings).not.toHaveBeenCalled();
  });

  it("refuses when the app has no webhook hook at all", async () => {
    mockGetAppSettings.mockResolvedValue(appWith([foreignSqsHook]));

    const code = await ensureWebhookSubscription("apply", APPLY);

    expect(code).toBe(1);
    expect(mockUpdateAppSettings).not.toHaveBeenCalled();
  });
});

/**
 * #1270 — the exit code, which is the whole reason this script can now be a
 * scheduled drift detector rather than something a human remembers to run.
 *
 * Before this, every one of these cases returned 0. The scheduled job would
 * have gone green while the live hook carried six of the ten handled event
 * types, which is the exact state #1134 found in production.
 */
describe("ensure-webhook-subscription — check mode exit codes", () => {
  it("fails when the live hook is missing a handled event type", async () => {
    mockGetAppSettings.mockResolvedValue(appWith([liveWebhook]));

    const code = await ensureWebhookSubscription("check");

    expect(code).toBe(DRIFT_EXIT_CODE);
    expect(mockUpdateAppSettings).not.toHaveBeenCalled();
  });

  it("passes when the live hook already covers every handled event", async () => {
    mockGetAppSettings.mockResolvedValue(
      appWith([{ ...liveWebhook, event_types: [...HANDLED_EVENT_TYPES] }]),
    );

    // `call.session_started` is subscribed on top of the handled list, so a
    // hook carrying only the handled types is still one short and must fail.
    expect(await ensureWebhookSubscription("check")).toBe(DRIFT_EXIT_CODE);

    mockGetAppSettings.mockResolvedValue(
      appWith([
        {
          ...liveWebhook,
          event_types: [...HANDLED_EVENT_TYPES, "call.session_started"],
        },
      ]),
    );

    expect(await ensureWebhookSubscription("check")).toBe(0);
  });

  it("fails when an event has no hook that may carry it — in EVERY mode", async () => {
    // Every handled event is `video`-scoped since #1270, so a `chat`-only hook
    // can carry none of them. `--apply` cannot fix this either: the remedy is a
    // new hook, which decides a public URL and belongs to a human. Reporting
    // success here is how a whole feature stays dead with the script saying it
    // is fine.
    const chatOnly = { ...liveWebhook, product: "chat" };
    mockGetAppSettings.mockResolvedValue(appWith([chatOnly]));
    expect(await ensureWebhookSubscription("check")).toBe(DRIFT_EXIT_CODE);

    mockGetAppSettings.mockResolvedValue(appWith([chatOnly]));
    expect(await ensureWebhookSubscription("apply", APPLY)).toBe(
      DRIFT_EXIT_CODE,
    );
  });

  it("still exits 1, not the drift code, when Stream is unconfigured", async () => {
    // The two must stay distinguishable: a missing runner secret and a
    // narrowed hook in the dashboard need completely different responses.
    mockIsStreamConfigured.mockReturnValueOnce(false);

    expect(await ensureWebhookSubscription("check")).toBe(1);
  });

  it("leaves the bare dry run green so a human can look without a red exit", async () => {
    mockGetAppSettings.mockResolvedValue(appWith([liveWebhook]));

    expect(await ensureWebhookSubscription("dry-run")).toBe(0);
  });
});

/**
 * The rollback, which this script did not have.
 *
 * It is the one script in `scripts/stream/` that writes to the shared APP rather
 * than to a single call type, so the thing it can destroy is the most expensive
 * object in the account: `event_hooks`, one hook carrying every video event type
 * the pipeline depends on. Losing it is indistinguishable from 2026-08-13, when
 * the pipeline had never processed an event — and without a pre-image there was
 * no record of what it had been subscribed to.
 */
describe("ensure-webhook-subscription — pre-image and rollback", () => {
  const WIDE = {
    ...liveWebhook,
    event_types: [...HANDLED_EVENT_TYPES, "call.session_started"],
  };

  /** Stage a pre-image holding the pre-widening `event_types` for `hook_live`. */
  function withPreImage() {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        capturedAt: "2026-09-29T00:00:00.000Z",
        hooks: { hook_live: [...liveWebhook.event_types] },
      }),
    );
  }

  it("writes a pre-image before it widens anything", async () => {
    mockGetAppSettings.mockResolvedValue(appWith([liveWebhook]));

    await ensureWebhookSubscription("apply", APPLY);

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const [tmpPath, payload] = mockWriteFileSync.mock.calls[0] as [
      string,
      string,
    ];
    // Write-then-rename, so an interrupted write cannot leave a truncated
    // pre-image where a valid one used to be.
    expect(tmpPath).toContain("webhook-subscription.json.tmp");
    expect(mockRenameSync).toHaveBeenCalledWith(
      tmpPath,
      expect.stringContaining("webhook-subscription.json"),
    );
    const image = JSON.parse(payload) as { hooks: Record<string, string[]> };
    // The PRE-widening list, or the rollback target is "after". Sorted by code
    // unit, the same rule every comparison of event types in this folder uses —
    // `localeCompare` would make the pre-image environment-dependent.
    expect(image.hooks.hook_live).toEqual([...liveWebhook.event_types].sort());
  });

  it("never silently overwrites an existing pre-image", async () => {
    // Applying twice would otherwise capture the already-widened state as the
    // rollback target — redefining "before" as "after", so `--restore` becomes a
    // no-op that reports success. The failure is invisible until the day
    // somebody actually needs the rollback.
    mockGetAppSettings.mockResolvedValue(appWith([liveWebhook]));
    mockExistsSync.mockReturnValue(true);

    await ensureWebhookSubscription("apply", APPLY);

    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("writes no pre-image on a dry run or a check", async () => {
    mockGetAppSettings.mockResolvedValue(appWith([liveWebhook]));

    await ensureWebhookSubscription("dry-run");
    await ensureWebhookSubscription("check");

    // A dry run must leave the working tree exactly as it found it, and creating
    // a backup file is a write.
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("refuses to restore with no pre-image rather than guessing", async () => {
    mockGetAppSettings.mockResolvedValue(appWith([liveWebhook]));

    const code = await ensureWebhookSubscription("restore", APPLY);

    expect(code).toBe(1);
    // Guessing in either direction is either a dead pipeline or a silent
    // re-subscription nobody reviewed.
    expect(mockUpdateAppSettings).not.toHaveBeenCalled();
  });

  it("REPORTS a rollback without writing, and names the command that writes it", async () => {
    withPreImage();
    mockGetAppSettings.mockResolvedValue(appWith([WIDE]));

    const code = await ensureWebhookSubscription("restore", APPLY);

    // A rollback is the command somebody types while an incident is open; it
    // should show what it is about to undo before it undoes it. Same posture as
    // `ensure-chat-type-grants.ts` and `--restore-user-join`.
    expect(code).toBe(0);
    expect(mockUpdateAppSettings).not.toHaveBeenCalled();
  });

  it("restores the pre-image event_types, and nothing else on the hook", async () => {
    withPreImage();
    const restored = { ...WIDE, event_types: [...liveWebhook.event_types] };
    // Read 1 is the pre-restore state; read 2 is what Stream stored. The second
    // has to be the RESTORED one or the read-back assertion fires — which is the
    // point of having a read-back assertion.
    mockGetAppSettings
      .mockResolvedValueOnce(appWith([WIDE, foreignSqsHook]))
      .mockResolvedValueOnce(appWith([restored, foreignSqsHook]));

    const code = await ensureWebhookSubscription("restore", {
      argv: ["--apply", "--restore", "--target-app", PRODUCTION_APP_NAME],
    });

    expect(code).toBe(0);
    const hook = submitted().find((h) => h.id === "hook_live");
    expect([...(hook?.event_types ?? [])].sort()).toEqual(
      [...liveWebhook.event_types].sort(),
    );
    // The hook's URL, enabled flag and product are NOT part of the rollback
    // target, and must be carried through untouched.
    expect(hook?.hook_type).toBe("webhook");
    expect(hook?.webhook_url).toBe(
      "https://familiarisenow.com/api/stream/webhooks",
    );
    // The SQS hook is not in the pre-image and must survive: `event_hooks` is
    // replaced wholesale, so a payload built from the pre-image alone would
    // delete it.
    expect(submitted().map((h) => h.id)).toContain("hook_sqs");
  });

  it("does NOT recreate a hook that was deleted after the pre-image was taken", async () => {
    withPreImage();
    // `hook_live` is gone from the app entirely.
    mockGetAppSettings.mockResolvedValue(appWith([foreignSqsHook]));

    const code = await ensureWebhookSubscription("restore", APPLY);

    expect(code).toBe(1);
    expect(mockUpdateAppSettings).not.toHaveBeenCalled();
  });

  it("fails the rollback if Stream did not restore what it was sent", async () => {
    // The direction the grants script got wrong: both post-write checks there
    // were gated on `!restore`, so a rollback reported success without ever
    // asking whether the restoration landed. "It went back to nearly what it
    // was" is not a state anybody can reason about at 2am.
    withPreImage();
    mockGetAppSettings
      .mockResolvedValueOnce(appWith([WIDE]))
      .mockResolvedValueOnce(appWith([WIDE])); // read-back unchanged

    const code = await ensureWebhookSubscription("restore", {
      argv: ["--apply", "--restore", "--target-app", PRODUCTION_APP_NAME],
    });

    expect(code).toBe(1);
  });

  it("is a no-op when the live hook already matches the pre-image", async () => {
    withPreImage();
    mockGetAppSettings.mockResolvedValue(appWith([liveWebhook]));

    const code = await ensureWebhookSubscription("restore", {
      argv: ["--apply", "--restore", "--target-app", PRODUCTION_APP_NAME],
    });

    expect(code).toBe(0);
    expect(mockUpdateAppSettings).not.toHaveBeenCalled();
  });
});

describe("ensure-webhook-subscription — the target-app guard", () => {
  it("refuses an --apply that names no target app", async () => {
    mockGetAppSettings.mockResolvedValue(appWith([liveWebhook]));

    const code = await ensureWebhookSubscription("apply", { argv: [] });

    expect(code).toBe(1);
    expect(mockUpdateAppSettings).not.toHaveBeenCalled();
  });

  it("refuses an --apply that names a DIFFERENT app", async () => {
    mockGetAppSettings.mockResolvedValue(appWith([liveWebhook]));

    const code = await ensureWebhookSubscription("apply", {
      argv: ["--target-app", "SomebodyElsesTrialApp"],
    });

    expect(code).toBe(1);
    expect(mockUpdateAppSettings).not.toHaveBeenCalled();
  });

  it("gates the rollback too", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        capturedAt: "2026-09-29T00:00:00.000Z",
        hooks: { hook_live: [...liveWebhook.event_types] },
      }),
    );
    mockGetAppSettings.mockResolvedValue(
      appWith([{ ...liveWebhook, event_types: ["call.ended"] }]),
    );

    // `--apply --restore` with no target named. A bare `--restore` does not
    // write, so it is not gated — and must not be, or an operator inspecting a
    // rollback could not see what it would do.
    const code = await ensureWebhookSubscription("restore", {
      argv: ["--apply"],
    });

    expect(code).toBe(1);
    expect(mockUpdateAppSettings).not.toHaveBeenCalled();
  });

  it("leaves a dry run, a check and a bare --restore alone", async () => {
    mockGetAppSettings.mockResolvedValue(appWith([liveWebhook]));

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        capturedAt: "2026-09-29T00:00:00.000Z",
        hooks: { hook_live: [...liveWebhook.event_types] },
      }),
    );

    expect(await ensureWebhookSubscription("dry-run", { argv: [] })).toBe(0);
    expect(await ensureWebhookSubscription("check", { argv: [] })).toBe(
      DRIFT_EXIT_CODE,
    );
    // A bare `--restore` reports what it would undo and writes nothing, so it is
    // not gated: an operator mid-incident must be able to look at a rollback
    // without first naming an app.
    expect(await ensureWebhookSubscription("restore", { argv: [] })).toBe(0);
    expect(mockUpdateAppSettings).not.toHaveBeenCalled();
  });
});
