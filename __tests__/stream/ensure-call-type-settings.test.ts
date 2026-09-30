/**
 * @jest-environment node
 */

/**
 * The call-type settings script, which now owns TWO call types and can refuse to
 * write.
 *
 * Three things are pinned here, and they are the three that have actually gone
 * wrong in this subsystem:
 *
 *   1. THE VALUES. Every fixture below is the state read off the LIVE call type
 *      with `video_get_call_type` on 2026-09-29, not off Stream's
 *      documentation. `livestream` had never been hardened by anything in this
 *      repository, and every value it carried — `auto-on` noise cancellation, a
 *      thirty-second inactivity timeout, three `available` recording families,
 *      `ingress.enabled: true`, 1080p, `max_participants: null` — was Stream's
 *      shipped default on a type that bills the same account.
 *
 *   2. THE RECORDING GUARD. This script disables three of Stream's four
 *      recording families; the fourth is the one `recording-service.ts` always
 *      needs. Nothing on the write path used to notice that, so the failure mode
 *      was a green tick over a config in which every consultation produced no
 *      recording file — discovered by a customer who asked for the recording.
 *
 *   3. THAT A PIN CANNOT RESET ITS NEIGHBOURS. Sub-objects are validated as a
 *      whole by Stream, so each block has to be rebuilt from the live read. A
 *      plan that omits a field must leave it alone, which is what makes the
 *      header's "NOT changed here, deliberately" list a property of the code
 *      rather than a thing to remember.
 */

const mockGetCallType = jest.fn();
const mockUpdateCallType = jest.fn();
const mockGetApp = jest.fn();
const mockWriteFileSync = jest.fn();
const mockMkdirSync = jest.fn();

jest.mock("node:fs", () => ({
  writeFileSync: (...a: unknown[]) => mockWriteFileSync(...a),
  mkdirSync: (...a: unknown[]) => mockMkdirSync(...a),
}));

jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: jest.fn(() => true),
  getStreamVideoClient: jest.fn(() => ({
    getApp: mockGetApp,
    video: { getCallType: mockGetCallType, updateCallType: mockUpdateCallType },
  })),
}));

import { join } from "path";
import {
  ensureCallTypeSettings,
  unusableRecordingMode,
  DRIFT_EXIT_CODE,
  type CallTypePlan,
} from "../../scripts/stream/ensure-call-type-settings";
import { STREAM_CALL_TYPE } from "../../lib/stream/call-cid";
import { PRODUCTION_APP_NAME } from "../../scripts/stream/target-guard";

const opts = (
  o: Partial<Parameters<typeof ensureCallTypeSettings>[0]> = {},
): Parameters<typeof ensureCallTypeSettings>[0] => {
  const { argv, ...rest } = o;
  return {
    apply: false,
    check: false,
    ...rest,
    argv: argv ?? (rest.apply ? ["--target-app", PRODUCTION_APP_NAME] : []),
  };
};

type Settings = Record<string, unknown>;

/**
 * The LIVE `default` settings, read 2026-09-29, trimmed to the sub-objects this
 * script touches. `limits.max_participants` is `null` because that is what the
 * live type reads — the one field on this type this change actually moves.
 * `recording.mode: "available"` is load-bearing: it is the family
 * `recording-service.ts` records in and the one this script must not take.
 */
const LIVE_DEFAULT = (): Settings => ({
  audio: {
    access_request_enabled: true,
    opus_dtx_enabled: true,
    redundant_coding_enabled: true,
    mic_default_on: true,
    speaker_default_on: true,
    default_device: "earpiece",
    noise_cancellation: { mode: "available" },
    hifi_audio_enabled: false,
  },
  backstage: { enabled: false },
  broadcasting: { enabled: false, hls: { enabled: true, auto_on: false } },
  frame_recording: {
    mode: "disabled",
    quality: "720p",
    capture_interval_in_seconds: 3,
  },
  individual_recording: { mode: "disabled" },
  raw_recording: { mode: "disabled" },
  ingress: { enabled: false, video_encoding_options: { count: 4 } },
  limits: {
    max_participants: null,
    max_participants_exclude_roles: [],
    max_duration_seconds: null,
  },
  recording: {
    mode: "available",
    quality: "720p",
    layout: { name: "spotlight", options: { count: 55 } },
  },
  session: { inactivity_timeout_seconds: 900 },
  transcription: { mode: "disabled", closed_caption_mode: "disabled" },
  video: {
    enabled: true,
    target_resolution: { width: 1280, height: 720, bitrate: 1500000 },
  },
});

/**
 * The LIVE `livestream` settings, read 2026-09-29 — every value this change
 * moves. `backstage.enabled: true` and `recording.mode: "available"` are
 * CORRECT there and must survive the write.
 */
const LIVE_LIVESTREAM = (): Settings => ({
  audio: {
    access_request_enabled: false,
    opus_dtx_enabled: true,
    redundant_coding_enabled: true,
    mic_default_on: false,
    speaker_default_on: true,
    default_device: "speaker",
    noise_cancellation: { mode: "auto-on" },
    hifi_audio_enabled: true,
  },
  backstage: { enabled: true },
  frame_recording: {
    mode: "available",
    quality: "720p",
    capture_interval_in_seconds: 3,
  },
  individual_recording: { mode: "available" },
  raw_recording: { mode: "available" },
  ingress: {
    enabled: true,
    audio_encoding_options: { channels: 2 },
    video_encoding_options: { count: 4, keys: ["1280x720x30"] },
  },
  limits: {
    max_participants: null,
    max_participants_exclude_roles: [],
    max_duration_seconds: null,
  },
  ring: {
    incoming_call_timeout_ms: 0,
    auto_cancel_timeout_ms: 0,
    missed_call_timeout_ms: 0,
  },
  recording: {
    mode: "available",
    quality: "720p",
    layout: { name: "spotlight", options: { count: 55 } },
  },
  session: { inactivity_timeout_seconds: 30 },
  broadcasting: { enabled: true, hls: { enabled: true, auto_on: false } },
  transcription: {
    mode: "available",
    closed_caption_mode: "available",
    languages: ["en"],
    language: "en",
  },
  video: {
    enabled: true,
    target_resolution: { width: 1920, height: 1080, bitrate: 3000000 },
  },
});

const NOTIFICATIONS = { enabled: true };

function mockCallType(name: string, settings: Settings) {
  return {
    name,
    grants: { user: ["join-call"], call_member: ["join-call"] },
    settings,
    notification_settings: NOTIFICATIONS,
  };
}

/** The `settings` payload of the last real write for one call type. */
function sentFor(name: string): Settings {
  const calls = mockUpdateCallType.mock.calls.filter((c) => c[0].name === name);
  // Two writes per type: the no-op probe first, the real write last.
  const last = calls.at(-1);
  if (!last) throw new Error(`updateCallType was never called for ${name}`);
  return (last[0].settings ?? {}) as Settings;
}

/** Stateful per call type, so the post-write re-read sees what was stored. */
let stored: Record<string, Settings>;

beforeEach(() => {
  jest.clearAllMocks();
  stored = {
    [STREAM_CALL_TYPE]: LIVE_DEFAULT(),
    livestream: LIVE_LIVESTREAM(),
  };
  mockGetApp.mockResolvedValue({ app: { name: PRODUCTION_APP_NAME } });
  mockGetCallType.mockImplementation(async ({ name }: { name: string }) =>
    mockCallType(name, structuredClone(stored[name])),
  );
  mockUpdateCallType.mockImplementation(
    async ({ name, settings }: { name: string; settings: Settings }) => {
      stored[name] = {
        ...stored[name],
        ...(structuredClone(settings) as Settings),
      };
      return {};
    },
  );
});

describe("the two call types this script owns", () => {
  it("reads `default` first, then `livestream`", async () => {
    // If a run is abandoned partway it must be abandoned having fixed the type
    // every live consultation is sitting on.
    await ensureCallTypeSettings(opts());
    expect(mockGetCallType.mock.calls.map((c) => c[0].name)).toEqual([
      STREAM_CALL_TYPE,
      "livestream",
    ]);
  });

  it("writes `default` exactly once, for exactly the one field that moved", async () => {
    // The live `default` type had already been hardened for frame recording,
    // ingress and the inactivity timeout by an earlier run. Re-asserting them is
    // how the drift gate tells a REVERTED value from a type it has never seen —
    // but re-asserting must not re-write them.
    await ensureCallTypeSettings(opts({ apply: true }));
    expect(sentFor(STREAM_CALL_TYPE)).toEqual({
      limits: {
        max_participants: 25,
        max_participants_exclude_roles: [],
        max_duration_seconds: null,
      },
    });
  });
});

describe("livestream — a type nothing here had hardened", () => {
  it("stops the noise-cancellation meter starting itself", async () => {
    await ensureCallTypeSettings(opts({ apply: true }));
    // `auto-on` means the moment `@stream-io/audio-filters-web` is registered,
    // every call on this type bills Krisp per participant-minute. `available`
    // keeps the capability and makes enabling it a deliberate client decision.
    const audio = sentFor("livestream").audio as {
      noise_cancellation: { mode: string };
    };
    expect(audio.noise_cancellation.mode).toBe("available");
  });

  it("takes the thirty-second inactivity timeout to 900", async () => {
    await ensureCallTypeSettings(opts({ apply: true }));
    // 30 is Stream's SHIPPED default, so it was never a decision made here — and
    // it is what fires `call.session_ended` while a backstage session is between
    // segments. #1277 is what that event did to a live consultation.
    const session = sentFor("livestream").session as {
      inactivity_timeout_seconds: number;
    };
    expect(session.inactivity_timeout_seconds).toBe(900);
  });

  it("disables the three recording families nothing calls", async () => {
    await ensureCallTypeSettings(opts({ apply: true }));
    const sent = sentFor("livestream");
    expect((sent.individual_recording as { mode: string }).mode).toBe(
      "disabled",
    );
    expect((sent.raw_recording as { mode: string }).mode).toBe("disabled");
    expect((sent.frame_recording as { mode: string }).mode).toBe("disabled");
  });

  it("closes the RTMP/OBS ingest door", async () => {
    await ensureCallTypeSettings(opts({ apply: true }));
    // Nothing in the app holds an ingest URL and Stream prices ingress at roughly
    // fifteen times a video call-minute. A built-in `true` on a type nobody uses
    // is a meter with the door open.
    expect(
      (sentFor("livestream").ingress as { enabled: boolean }).enabled,
    ).toBe(false);
  });

  it("aligns video to 720p so an 11-tile gallery stops billing 1080p", async () => {
    await ensureCallTypeSettings(opts({ apply: true }));
    // Stream bills AGGREGATED RECEIVED resolution and cannot cap what a client
    // sends, so a 1080p target on the gallery type is a permanent 2x line item.
    expect(
      (sentFor("livestream").video as { target_resolution: unknown })
        .target_resolution,
    ).toEqual({ width: 1280, height: 720, bitrate: 1500000 });
  });

  it("disables file transcription but LEAVES closed captions available", async () => {
    await ensureCallTypeSettings(opts({ apply: true }));
    const transcription = sentFor("livestream").transcription as {
      mode: string;
      closed_caption_mode: string;
    };
    // File transcription is ~$8/1k call-minutes and a durable artefact nobody
    // asked for. Real-time captions are an accessibility feature a host opts into
    // at go-live — a cost they agreed to, which is the distinction this file draws.
    expect(transcription.mode).toBe("disabled");
    expect(transcription.closed_caption_mode).toBe("available");
  });

  it("rebuilds each sub-object from the live read rather than from a literal", async () => {
    await ensureCallTypeSettings(opts({ apply: true }));
    const sent = sentFor("livestream");
    // Stream validates a sub-object as a whole — `audio` without
    // `default_device` is rejected — so the read has to be spread in. And
    // `livestream` needed it most: it carries a populated ingress encoder ladder
    // and `hifi_audio_enabled: true` that `default` does not.
    expect((sent.audio as { default_device: string }).default_device).toBe(
      "speaker",
    );
    expect(
      (sent.audio as { hifi_audio_enabled: boolean }).hifi_audio_enabled,
    ).toBe(true);
    expect(
      (sent.frame_recording as { capture_interval_in_seconds: number })
        .capture_interval_in_seconds,
    ).toBe(3);
    expect(
      (sent.ingress as { video_encoding_options: { count: number } })
        .video_encoding_options.count,
    ).toBe(4);
  });

  it("folds two pins in the same sub-object rather than replacing one", async () => {
    await ensureCallTypeSettings(opts({ apply: true }));
    const transcription = sentFor("livestream").transcription as Record<
      string,
      unknown
    >;
    expect(transcription.mode).toBe("disabled");
    expect(transcription.closed_caption_mode).toBe("available");
    // The live read had `language: "en"`; folding must not drop it.
    expect(transcription.language).toBe("en");
  });

  it("does not let a second pin in a section restore the first pin's live value", async () => {
    // `livestream` pins two fields inside `transcription`. Building each section
    // from the live read and folding in pin order looks equivalent and is not:
    // the second block still carries the LIVE `mode`, so folding it over the
    // first quietly puts `mode` back to `available` and the type goes on billing
    // file transcription at ~$8/1k call-minutes. The assertion that catches it is
    // "both fields are in ONE payload" — the stored-state check alone passes
    // either way, because the mock merges section by section.
    await ensureCallTypeSettings(opts({ apply: true }));
    const payload = sentFor("livestream").transcription as Record<
      string,
      unknown
    >;
    expect(Object.keys(payload)).toEqual(
      expect.arrayContaining(["mode", "closed_caption_mode"]),
    );
    expect(payload.mode).toBe("disabled");
    expect((stored.livestream.transcription as { mode: string }).mode).toBe(
      "disabled",
    );
  });

  it("leaves the correct values on this type alone", async () => {
    await ensureCallTypeSettings(opts({ apply: true }));
    // `backstage` and `recording` are pinned AT their live values, so the payload
    // must not carry them at all — a pin that matches is a no-op, and a write for
    // it would be re-touching a document for no reason.
    const sent = sentFor("livestream");
    expect(sent.backstage).toBeUndefined();
    expect(sent.recording).toBeUndefined();
    expect(stored.livestream.backstage).toEqual({ enabled: true });
    expect((stored.livestream.recording as { mode: string }).mode).toBe(
      "available",
    );
  });

  it("does not touch `ring`, which livestream carries and default does not", async () => {
    await ensureCallTypeSettings(opts({ apply: true }));
    // A whole sub-object that no pin mentions must survive untouched. This is the
    // property that makes the header's "NOT changed here, deliberately" list
    // enforceable rather than aspirational.
    expect(sentFor("livestream").ring).toBeUndefined();
    expect(stored.livestream.ring).toEqual({
      incoming_call_timeout_ms: 0,
      auto_cancel_timeout_ms: 0,
      missed_call_timeout_ms: 0,
    });
  });
});

describe("limits.max_participants", () => {
  it("caps `default` at 25 and `livestream` at 100", async () => {
    await ensureCallTypeSettings(opts({ apply: true }));
    // 25: under ClassPlan.maxParticipants (30), so a real class never notices,
    // and seven times a 1:1. 100: exactly WebinarPlan.maxParticipants, so the cap
    // is invisible to every webinar the product will let you sell.
    expect(
      (sentFor(STREAM_CALL_TYPE).limits as { max_participants: number })
        .max_participants,
    ).toBe(25);
    expect(
      (sentFor("livestream").limits as { max_participants: number })
        .max_participants,
    ).toBe(100);
  });

  it("carries max_duration_seconds through untouched", async () => {
    await ensureCallTypeSettings(opts({ apply: true }));
    // It counts from the first participant joining, not from `starts_at`, so
    // setting it to the booked length hard-terminates a session up to fifteen
    // minutes early when a consultant joins to check their camera (#1144).
    const limits = sentFor(STREAM_CALL_TYPE).limits as Record<string, unknown>;
    expect(limits.max_duration_seconds).toBeNull();
    expect(limits.max_participants_exclude_roles).toEqual([]);
  });
});

describe("B5 — the recording guard", () => {
  it("refuses to apply when the computed target would not record", async () => {
    stored[STREAM_CALL_TYPE] = {
      ...LIVE_DEFAULT(),
      recording: { mode: "disabled" },
    };

    const code = await ensureCallTypeSettings(opts({ apply: true }));

    expect(code).toBe(1);
    expect(mockUpdateCallType).not.toHaveBeenCalled();
  });

  it("repairs a livestream recording.mode rather than refusing", async () => {
    // `livestream` PINS `recording.mode` at `available`, so the computed target
    // is usable however the live value reads and the script heals it. That is
    // the difference between the two plans: `default` has no `recording` pin, so
    // a broken live value there is something the script refuses to touch — see
    // the refusal cases above. Both are consequences of computing the target
    // rather than reading the live value and hoping.
    stored.livestream = {
      ...LIVE_LIVESTREAM(),
      recording: { mode: "disabled" },
    };

    const code = await ensureCallTypeSettings(opts({ apply: true }));

    expect(code).toBe(0);
    expect((stored.livestream.recording as { mode: string }).mode).toBe(
      "available",
    );
  });

  it("prints the refusal BEFORE any diff, so it is the first thing read", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    stored[STREAM_CALL_TYPE] = {
      ...LIVE_DEFAULT(),
      recording: { mode: "disabled" },
    };

    await ensureCallTypeSettings(opts({ apply: true }));

    const lines = [...log.mock.calls, ...error.mock.calls].map((c) =>
      String(c[0]),
    );
    const refusal = lines.findIndex((l) => l.includes("Refusing to apply"));
    const report = lines.findIndex((l) => l.includes("Pending changes"));
    expect(refusal).toBeGreaterThan(-1);
    // And nothing was diffed. The refusal is the FIRST thing printed for the
    // refused type, so the reader never sees a change list they have already
    // half-agreed to — and `livestream` is never reached, because an operator
    // told "no" about one call type has not been told anything about the other.
    expect(report).toBe(-1);
    log.mockRestore();
    error.mockRestore();
  });

  it("fails the run if the recording mode was usable before and is not after", async () => {
    // The pre-write check proves the target was usable; this proves it is STILL
    // usable, which is a different question. `updateCallType` merges at the top
    // level and validates whole at the sub-object level, and neither promise says
    // what a `recording` block it was not given looks like afterwards.
    const drifted = {
      ...LIVE_DEFAULT(),
      limits: {
        max_participants: null,
        max_participants_exclude_roles: [],
        max_duration_seconds: null,
      },
    };
    mockGetCallType
      // initial read, then the post-probe read: recording fine
      .mockResolvedValueOnce(mockCallType(STREAM_CALL_TYPE, drifted))
      .mockResolvedValueOnce(mockCallType(STREAM_CALL_TYPE, drifted))
      // the post-write read: the block this write was not given is gone
      .mockResolvedValueOnce(
        mockCallType(STREAM_CALL_TYPE, {
          ...drifted,
          recording: { mode: "disabled" },
        }),
      );

    const code = await ensureCallTypeSettings(opts({ apply: true }));

    expect(code).toBe(1);
  });

  it("accepts a plan that pins recording.mode to something that records", () => {
    const plan: CallTypePlan = {
      name: "x",
      rationale: "x",
      pins: [
        {
          section: "recording",
          field: "mode",
          read: (s) => (s as { recording?: { mode?: string } }).recording?.mode,
          target: "available",
        },
      ],
    };
    expect(
      unusableRecordingMode({ recording: { mode: "disabled" } } as never, plan),
    ).toBeNull();
  });

  it("names composite, so the refusal explains what would break", () => {
    const why = unusableRecordingMode(
      { recording: { mode: "disabled" } } as never,
      { name: "x", rationale: "x", pins: [] },
    );
    expect(why).toContain('recording_type "composite"');
  });

  it("agrees with lib/stream/recording-service.ts on the recording family", () => {
    // `RECORDING_TYPE` is module-private in recording-service.ts, and that file
    // is owned by another change in this series, so this script restates it.
    // Restated constants drift; this is the check that they have not. Same
    // technique grants-deploy-gate.test.ts uses to pin the deploy gate.
    const source = jest
      .requireActual("node:fs")
      .readFileSync(
        join(process.cwd(), "lib/stream/recording-service.ts"),
        "utf8",
      ) as string;
    expect(source.match(/const RECORDING_TYPE = "(\w+)"/)?.[1]).toBe(
      "composite",
    );
  });
});

describe("merge-vs-replace, per call type", () => {
  it("probes `livestream` too — that document had never been probed", async () => {
    await ensureCallTypeSettings(opts({ apply: true }));
    const probes = mockUpdateCallType.mock.calls
      .filter((c) => c[0].name === "livestream")
      .map((c) => c[0].settings as Settings);
    // The probe comes first and is a no-op; the real write comes second. "Stream
    // merges" was established for the `default` DOCUMENT, and `livestream` is a
    // different one — it carries `ring`, a populated `broadcasting` block and an
    // ingress encoder ladder that `default` does not.
    expect(probes).toHaveLength(2);
    expect(
      (probes[0].session as { inactivity_timeout_seconds: number })
        .inactivity_timeout_seconds,
    ).toBe(30);
  });

  it("aborts before the real write if the probe moved the grants", async () => {
    mockGetCallType
      .mockResolvedValueOnce(mockCallType(STREAM_CALL_TYPE, LIVE_DEFAULT()))
      .mockResolvedValueOnce({
        ...mockCallType(STREAM_CALL_TYPE, LIVE_DEFAULT()),
        grants: {},
      });

    const code = await ensureCallTypeSettings(opts({ apply: true }));

    expect(code).toBe(1);
    // Exactly one call: the probe. `updateCallType` replacing the grants map
    // would lock every participant out of every call, because `user`, `guest`
    // and `call_member` all hold `join-call` on `default`.
    expect(mockUpdateCallType).toHaveBeenCalledTimes(1);
  });

  it("writes a pre-image for each type before it touches either", async () => {
    await ensureCallTypeSettings(opts({ apply: true }));
    expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
    const paths = mockWriteFileSync.mock.calls.map((c) => String(c[0]));
    expect(paths[0]).toContain(`call-type-${STREAM_CALL_TYPE}.`);
    expect(paths[1]).toContain("call-type-livestream.");
    const payload = JSON.parse(
      mockWriteFileSync.mock.calls[1][1] as string,
    ) as { settings: Settings; grants: unknown };
    // The pre-image is the only copy of a config Stream might have discarded.
    expect(payload.settings.recording).toEqual(LIVE_LIVESTREAM().recording);
    expect(payload.grants).toBeDefined();
  });

  it("fails the run if Stream does not store what it was sent", async () => {
    const drifted = LIVE_LIVESTREAM();
    // Every read returns the pre-write state, so the re-read looks like a write
    // that did not take. A green tick over a livestream still running
    // `auto-on` noise cancellation is the failure this whole exercise exists to
    // make loud.
    mockGetCallType.mockImplementation(async ({ name }: { name: string }) =>
      mockCallType(name, name === "livestream" ? drifted : LIVE_DEFAULT()),
    );

    const code = await ensureCallTypeSettings(opts({ apply: true }));

    expect(code).toBe(1);
  });
});

describe("--check", () => {
  it("exits 2 on drift, writes nothing, and annotates each type", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});

    const code = await ensureCallTypeSettings(opts({ check: true }));

    expect(code).toBe(DRIFT_EXIT_CODE);
    expect(mockUpdateCallType).not.toHaveBeenCalled();
    const said = error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toContain(`\`${STREAM_CALL_TYPE}\``);
    expect(said).toContain("`livestream`");
    error.mockRestore();
  });

  it("exits 0 when both types are at target", async () => {
    await ensureCallTypeSettings(opts({ apply: true }));
    mockUpdateCallType.mockClear();

    const code = await ensureCallTypeSettings(opts({ check: true }));

    expect(code).toBe(0);
    expect(mockUpdateCallType).not.toHaveBeenCalled();
  });

  it("annotates only the types that moved", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    stored[STREAM_CALL_TYPE] = {
      ...LIVE_DEFAULT(),
      limits: {
        max_participants: 25,
        max_participants_exclude_roles: [],
        max_duration_seconds: null,
      },
    };

    const code = await ensureCallTypeSettings(opts({ check: true }));

    expect(code).toBe(DRIFT_EXIT_CODE);
    const said = error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toContain("`livestream`");
    expect(said).not.toContain(
      `call-type settings drift on \`${STREAM_CALL_TYPE}\``,
    );
    error.mockRestore();
  });

  it("does not need a target app — a scheduled runner has none to name", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});

    const code = await ensureCallTypeSettings(opts({ check: true, argv: [] }));

    expect(code).toBe(DRIFT_EXIT_CODE);
    expect(error.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain(
      "Refusing to write",
    );
    error.mockRestore();
  });
});

describe("the target-app guard", () => {
  it("refuses an --apply that names no target app", async () => {
    const code = await ensureCallTypeSettings(opts({ apply: true, argv: [] }));
    expect(code).toBe(1);
    expect(mockUpdateCallType).not.toHaveBeenCalled();
  });

  it("refuses an --apply that names a DIFFERENT app", async () => {
    const code = await ensureCallTypeSettings(
      opts({ apply: true, argv: ["--target-app", "SomebodyElsesTrialApp"] }),
    );
    expect(code).toBe(1);
    expect(mockUpdateCallType).not.toHaveBeenCalled();
  });

  it("refuses when the credentials resolve to a different app", async () => {
    // The half of the guard a declaration cannot make. A correct declaration does
    // not save a wrong credential.
    mockGetApp.mockResolvedValue({ app: { name: "Familiarise Staging" } });

    const code = await ensureCallTypeSettings(opts({ apply: true }));

    expect(code).toBe(1);
    expect(mockUpdateCallType).not.toHaveBeenCalled();
  });

  it("leaves a dry run alone", async () => {
    const code = await ensureCallTypeSettings(opts({ argv: [] }));
    expect(code).toBe(0);
    expect(mockUpdateCallType).not.toHaveBeenCalled();
  });
});
