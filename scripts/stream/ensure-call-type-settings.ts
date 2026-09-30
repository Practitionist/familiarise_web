/**
 * Pin the video call types this app runs on to a posture that does not leak
 * money, and refuse to write one that would.
 *
 * ## The scope grew from one call type to two
 *
 * `STREAM_CALL_TYPE` is `default` and always was. `livestream` is the other
 * type this repository may resolve calls against, and it had never been
 * hardened by anything: it is a Stream built-in, and Stream ships built-ins
 * permissive. Everything below was read off the LIVE `livestream` type with
 * `video_get_call_type` on 2026-09-29, and every one of those values was
 * Stream's shipped default rather than anything this app chose.
 *
 * `harden-unused-call-types.ts` lists `livestream` in `UNUSED_TYPES` and strips
 * reach and billable grants from it, and that list deliberately still does —
 * removing it would be a migration decision, not a hardening one. So this script
 * does not compete with it. It drives `livestream` to a posture that is safe in
 * BOTH futures: a type we end up using is not billing anything nobody asked for,
 * and a type we never migrate to is not the reason a participant could have
 * started a $15/1k-minute RTMP ingest. Whichever way the migration goes, the
 * type is not leaking.
 *
 * ## `default` — the type every consultation runs on
 *
 * Read live 2026-09-29. Only the last row still MOVES; the rest were pinned by
 * an earlier run of this script and are re-asserted rather than left alone, for
 * the reason that matters: a pin is what tells the drift gate a REVERTED value
 * from a type this script has never seen, and from here those two states are
 * otherwise identical.
 *
 *   audio.noise_cancellation.mode       available (was auto-on)
 *     Krisp bills per participant-minute and `auto-on` starts the meter the moment
 *     `@stream-io/audio-filters-web` is registered — registering the instance and
 *     switching on the charge are the same act (#1158). `available` keeps the
 *     capability and makes enabling it a deliberate client-side decision.
 *
 *   individual_recording.mode           disabled (was available)
 *   raw_recording.mode                  disabled (was available)
 *   frame_recording.mode                disabled (was available)
 *     Stream ships permissive call-type defaults, so "we have not built it" and
 *     "it cannot be started" are different statements (#1160). All three are
 *     billable and entirely unused — we record `composite` and nothing else.
 *
 *   ingress.enabled                     false (was true)
 *     RTMP/OBS ingest, ~$15/1k call-minutes, with no ingest URL anywhere in the
 *     app. `start-broadcast-call` was never revoked either, which is how a
 *     participant with the SDK could have livestreamed a private consultation.
 *
 *   session.inactivity_timeout_seconds  900 (was 30)
 *     Stream fires `call.session_ended` this long after the LAST participant
 *     leaves. At thirty seconds, one party stepping out mid-appointment ended the
 *     session: both sides locked out, the slot marked complete, and in one
 *     direction an automatic full refund against a consultant who was three
 *     minutes late. #1277 fixed the consequences in code; this removes the event
 *     from the hot path entirely. The two fail independently, which is the point
 *     of doing both.
 *
 *   limits.max_participants             null -> 25
 *     The only field this revision actually moves on `default`. See the section
 *     on the two caps below for why 25 and not something larger.
 *
 * ## `livestream` — never hardened, read live 2026-09-29
 *
 *   audio.noise_cancellation.mode       auto-on -> available
 *     Same money, same reason, worse: this type had `hifi_audio_enabled: true`
 *     too, and `auto-on` starts the meter on the moment
 *     `@stream-io/audio-filters-web` is registered.
 *
 *   session.inactivity_timeout_seconds  30 -> 900
 *     30 is Stream's SHIPPED default, which means it was never a decision
 *     anybody made here. On `default` it had already been fixed; on the type a
 *     webinar would run on it was still live, and thirty seconds after the LAST
 *     participant leaves Stream fires `call.session_ended` — which on a
 *     backstage session kills the room while the hosts are between segments and
 *     everyone rejoins to a closed call. The recorded consequence of that event
 *     on `default` is in #1277: the slot marked complete, both sides locked
 *     out, and in one direction an automatic full refund against a consultant
 *     who was three minutes late.
 *
 *   individual_recording / raw_recording / frame_recording   available -> disabled
 *     We record `composite` and nothing else. `recording-service.ts` pins
 *     `RECORDING_TYPE = "composite"` at the only two call sites that start or
 *     stop a recording, so these three families are billable surface with no
 *     caller. `individual_recording` is per-participant, so it is the most
 *     expensive of the three by the same argument as noise cancellation.
 *
 *   ingress.enabled                    true -> false
 *     RTMP/OBS ingest. Nothing in the app holds an ingest URL, the
 *     `lib/stream` client never reads one, and Stream prices it at roughly
 *     fifteen times a video call-minute. A built-in default of `true` on a type
 *     nobody uses is a meter with the door open.
 *
 *   video.target_resolution            1920x1080 @ 3.0 Mbps -> 1280x720 @ 1.5 Mbps
 *     Aligned to `default`. Stream bills AGGREGATED RECEIVED resolution, and it
 *     cannot cap what a client sends: a participant publishing 1080p drags the
 *     whole call into the 1080p bucket regardless of what this field says. So a
 *     1080p default on the type a gallery call resolves against is a 2x line-item
 *     that no setting on this call type can undo. `default` was already 720p;
 *     this closes the gap between the two.
 *
 *   transcription.mode                 available -> disabled
 *     File transcription is ~$8/1k call-minutes — the most expensive thing on
 *     the page — and it produces a durable transcript of what was said in a
 *     room. Nobody in the app requests one, and a participant must not be able
 *     to.
 *
 *   closed_caption_mode                available -> available  (PINNED, not changed)
 *     Deliberately left on, and deliberately pinned so it is a decision rather
 *     than an inheritance. Real-time captions are an accessibility feature and a
 *     webinar is exactly where they are wanted; a host opting in at go-live is a
 *     cost they agreed to, which is the whole distinction this file draws. The
 *     self-serve half of that is closed in the GRANTS, not here —
 *     `ensure-call-type-grants.ts` takes `start-closed-captions` off every
 *     ordinary role, so the only way to bill for captions here is a server
 *     client or the host's own token.
 *
 *   backstage.enabled                  true -> true  (KEPT)
 *     Correct for this type and the one setting on it that is not Stream's
 *     default. Backstage is how a webinar is prepared before it is public, and
 *     turning it off would mean the production move mints a call the audience
 *     can walk into. Pinned so that a dashboard edit removing it is reported as
 *     drift rather than discovered during a live broadcast.
 *
 *   limits.max_participants            null -> 100
 *
 * ## `limits.max_participants`, and why these two numbers
 *
 * Both types read `null` live, which is not "no limit" so much as "no
 * decision". A `1:10 class` is a marketing promise the product makes, and with
 * `null` there is nothing at all to stop an eleventh person joining — and
 * because Stream CANNOT cap aggregated received resolution, an eleven-tile
 * gallery silently bills in the 1080p bucket that an 11-participant
 * full-mesh call should never have reached. The cap is the only lever we have.
 *
 *   default    = 25
 *     `default` is where a consultation and a small-group class run, and the
 *     largest legitimate use of it is a class. `ClassPlan.maxParticipants`
 *     defaults to 30; 25 sits under that with room to spare, and is seven times
 *     the realistic ceiling of a 1:1 — so a real class never notices the ceiling
 *     and a room that has gone wrong cannot keep growing. Deliberately well
 *     above anything a consultation needs (two) and below the plan default, so
 *     the number that would ever hurt somebody is one the plan layer will have
 *     rejected first.
 *
 *   livestream  = 100
 *     A webinar is a broadcast, and `WebinarPlan.maxParticipants` defaults to
 *     100. Matching the plan default exactly means the cap is invisible to every
 *     webinar the product will actually let you sell, and the only sessions that
 *     reach it are ones a plan has already promised. Higher than `default`
 *     because the attendee shape is genuinely different — an audience, not a
 *     group — and lower than nothing, which is where we are.
 *
 * If a plan type is ever raised above these, raise the cap in the SAME change
 * with the plan's own PR attached, or the plan becomes unsellable for reasons
 * that will look like a Stream bug.
 *
 * ## NOT changed here, deliberately
 *
 *   limits.max_duration_seconds stays null on both types. It counts from the
 *     first participant joining, not from `starts_at`, so setting it to the
 *     booked length hard-terminates a session up to fifteen minutes early when
 *     a consultant joins to check their camera (#1144).
 *
 *   `default`'s backstage stays disabled — that is #1070's decision, not this
 *   script's.
 *
 *   `default`.recording.layout stays `spotlight`. Switching to `grid` would
 *     change every recording, including webinars, for a 1:1 benefit nobody has
 *     shown.
 *
 *   `default`.transcription.closed_caption_mode is NOT pinned. The live value is
 *     `disabled` and leaving it unpinned means enabling real-time captions on
 *     consultations later — a product decision, taken deliberately, with a diff
 *     — is not immediately reported as drift. `livestream`'s IS pinned, because
 *     there the decision has already been made and only the dashboard could
 *     unmake it.
 *
 * ## The two guards
 *
 * ⚠️ MERGE-VS-REPLACE. Stream does not document whether `updateCallType` merges
 * or replaces the top-level fields it is not given, and the chat twin
 * (`channel.update()`) is a FULL REPLACE. `ensure-call-type-grants.ts` raised
 * the same question from the other side and left it open. If a write carrying
 * only `settings` replaced the document, `grants` goes with it — and `user`,
 * `guest` and `call_member` all hold `join-call` on `default`, so losing the
 * grants map is a total video outage. A full pre-image is written to disk
 * before either write, and a NO-OP PROBE re-reads and compares first. The probe
 * answered it on 2026-08-30 for `default` (top-level `settings` fields MERGE and
 * a settings write leaves `grants` and `notification_settings` alone); it had
 * never been run against `livestream`, and it runs per type now, because
 * "Stream merges" is a fact about an endpoint and not about a document.
 *
 * ⚠️ RECORDING. This script disables three of Stream's four recording families.
 * The fourth — `recording.mode`, the one `composite` belongs to — is NOT this
 * script's to set, and a script that rewrites neighbouring sub-objects while
 * leaving the load-bearing one untouched is one refactor away from taking
 * recordings down. So the computed target is checked BEFORE the write, against
 * the value this run would leave in place, and the value Stream stored is
 * checked again after it. The cost of getting that wrong is not a config
 * inconsistency: it is every consultation in the product silently having no
 * recording file when the attendee asks for one.
 *
 * Sub-objects are a separate matter: they are validated as a whole, so `audio`
 * without `default_device` and `frame_recording` without a valid
 * `capture_interval_in_seconds` are both rejected. Each block is therefore
 * rebuilt from the live read rather than written from a literal — which is also
 * what keeps a plan from silently resetting whatever it did not mention.
 *
 * ## Modes
 *
 * `--check` is the CI mode: no write, an annotation per drifted field, exit 2.
 * Run daily, and on any pull request that touches this file, by
 * `.github/workflows/stream-calltype-drift.yml`. A call type configured in the
 * Stream dashboard leaves no commit and no failing test.
 *
 * `--apply` additionally requires the target app to be named — see
 * `target-guard.ts`. Dev, preview and production share one Stream app.
 *
 *   npx tsx scripts/stream/ensure-call-type-settings.ts
 *   npx tsx scripts/stream/ensure-call-type-settings.ts --check
 *   npx tsx scripts/stream/ensure-call-type-settings.ts --apply
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import type { CallSettingsResponse } from "@stream-io/node-sdk";
import { getStreamVideoClient, isStreamConfigured } from "@/lib/stream-client";
import { canonical } from "@/lib/stream/config-fingerprint";
// The same constant the app itself resolves calls against, not an env var —
// `ensure-call-type-grants.ts` imports it from here too. Reading a separate
// env var would let the grants script and this one harden DIFFERENT call
// types, which is the divergence class this subsystem keeps repeating.
import { STREAM_CALL_TYPE } from "../../lib/stream/call-cid";
import { PRODUCTION_APP_NAME, requireNamedTargetApp } from "./target-guard";

const BACKUP_DIR = ".stream-backups";

/**
 * The recording family the app actually records in.
 *
 * `lib/stream/recording-service.ts` declares this as a module-private constant
 * and pins it at the only two call sites that start and stop a recording
 * (`call.startRecording` / `call.stopRecording`). Restated here rather than
 * imported because that file is owned by another change in this series and
 * exporting a constant from it is a wider edit than a hardening script deserves;
 * `__tests__/stream/ensure-call-type-settings.test.ts` greps the source and
 * fails if the two ever disagree, which is the same technique
 * `grants-deploy-gate.test.ts` uses to pin the deploy gate to its own script.
 *
 * It matters here because it is what makes `recording.mode` load-bearing: the
 * three families this script disables are the ones we never call, and this is
 * the one we always do.
 */
const RECORDING_TYPE = "composite";

/**
 * `recording.mode` values under which a server-started `composite` recording is
 * possible. `available` is what both types read live; `auto-on` starts one
 * unasked, which would be its own kind of leak, so it is listed as recording
 * but nothing in this file sets it.
 */
const MODES_THAT_RECORD: readonly string[] = ["available", "auto-on"];

/**
 * Distinct from 1 on purpose, and for the reason
 * `ensure-webhook-subscription.ts` states it: 1 means the script could not
 * evaluate drift at all (Stream unconfigured or unreachable), which is a failure
 * of the RUNNER; 2 means it read both call types successfully and there really is
 * drift. Both fail the scheduled job, and a log reader should not have to guess
 * which — a missing credential and a dashboard edit that set
 * `limits.max_participants` back to `null` need completely different responses.
 */
export const DRIFT_EXIT_CODE = 2;

/** GitHub Actions annotation; a plain line anywhere else. */
function annotate(message: string): void {
  console.error(
    process.env.GITHUB_ACTIONS ? `::error::${message}` : `ERROR: ${message}`,
  );
}

/** The sub-objects a `CallSettingsRequest` validates as a whole. */
type Section =
  | "audio"
  | "backstage"
  | "frame_recording"
  | "individual_recording"
  | "raw_recording"
  | "ingress"
  | "limits"
  | "session"
  | "transcription"
  | "video"
  | "recording";

/**
 * One pinned field: where to read it, and what it must become.
 *
 * Read, target and read-back live in ONE entry on purpose. The three used to be
 * three separate `if` statements in three separate blocks, which is how a field
 * can end up checked on the way in and not on the way out — and how a field can
 * end up written and not compared. Here they cannot: a pin that exists is
 * reported, sent and verified by construction.
 *
 * `field` is the KEY Stream receives. `label` is how the setting is named in the
 * report, and the two differ wherever a section holds a nested object
 * (`audio.noise_cancellation.mode` is the key `noise_cancellation` with `mode`
 * inside it). Conflating them writes a key named
 * `audio.noise_cancellation.mode` into the payload, which Stream ignores — and
 * the read-back then reports drift against a write that was never sent, which is
 * the right outcome for the wrong reason and would send an operator hunting a
 * Stream bug that is in this file.
 */
interface Pin {
  /** The sub-object being rebuilt from the live read. */
  section: Section;
  /** The key inside it, as sent. */
  field: string;
  /** How the report names it. Defaults to `field`. */
  label?: string;
  read: (s: CallSettingsResponse) => unknown;
  target: unknown;
}

/** `x.y` for the report, so a diff line names the setting the way docs do. */
function name(p: Pin): string {
  return p.label ?? `${p.section}.${p.field}`;
}

const pin = (
  section: Section,
  field: string,
  read: (s: CallSettingsResponse) => unknown,
  target: unknown,
  label?: string,
): Pin => ({ section, field, read, target, label });

/** Stream's own `FrameRecordingMode` union, restated for the `as never` cast. */
type NoiseCancellationMode = "disabled" | "available" | "auto-on";
type RecordingMode = "disabled" | "available" | "auto-on";
type TranscriptionMode = "disabled" | "available" | "auto-on";

export interface CallTypePlan {
  /** The call type's name in Stream, i.e. the cid prefix. */
  name: string;
  /** Printed above the diff, so the operator knows why they are reading it. */
  rationale: string;
  pins: Pin[];
}

/**
 * `default` — every consultation, and every class that has not been migrated.
 *
 * `frame_recording`, `ingress` and the inactivity timeout are already at target
 * on the live type; they stay pinned so that a dashboard edit that puts them back
 * is reported as drift instead of being indistinguishable from a type this script
 * has never seen.
 */
const DEFAULT_PLAN: CallTypePlan = {
  name: STREAM_CALL_TYPE,
  rationale:
    "the type every consultation resolves against — self-serve metering and an unbounded gallery are both unacceptable here",
  pins: [
    pin(
      "audio",
      "noise_cancellation",
      (s) => s.audio?.noise_cancellation,
      // A WHOLE `noise_cancellation` object rather than a mode string, because
      // that is the shape `audio.noise_cancellation` has on the wire: `mode` is
      // its only member today, and it is the key Stream expects in the payload.
      // Reading and targeting the same SHAPE is what lets the comparison below be
      // a value comparison; a pin that read `…?.mode` and targeted `{mode}` could
      // never compare equal, so the field would be re-sent on every run forever.
      { mode: "available" } satisfies { mode: NoiseCancellationMode },
      "audio.noise_cancellation.mode",
    ),
    pin(
      "frame_recording",
      "mode",
      (s) => s.frame_recording?.mode,
      "disabled" satisfies RecordingMode,
    ),
    pin(
      "individual_recording",
      "mode",
      (s) => s.individual_recording?.mode,
      "disabled" satisfies RecordingMode,
    ),
    pin(
      "raw_recording",
      "mode",
      (s) => s.raw_recording?.mode,
      "disabled" satisfies RecordingMode,
    ),
    pin("ingress", "enabled", (s) => s.ingress?.enabled, false),
    pin(
      "session",
      "inactivity_timeout_seconds",
      (s) => s.session?.inactivity_timeout_seconds,
      900,
    ),
    // See the header for why 25 and not 30 or 100.
    pin("limits", "max_participants", (s) => s.limits?.max_participants, 25),
    // `mode` only. `closed_caption_mode` is left unpinned ON PURPOSE so that
    // turning real-time captions on for consultations is a product decision with
    // a diff, not drift the gate reports every day until somebody notices.
    pin(
      "transcription",
      "mode",
      (s) => s.transcription?.mode,
      "disabled" satisfies TranscriptionMode,
    ),
    // #1070 decided consultations do not run in backstage. This script does not
    // CHANGE it — the live value is already `false` — but pinning it means a
    // dashboard edit that opens it is reported as drift rather than discovered
    // the first time a participant joins early and lands in a room nobody was
    // told about. Monitoring a decision is not the same as making it.
    pin("backstage", "enabled", (s) => s.backstage?.enabled, false),
  ],
};

/**
 * `livestream` — a type this app may yet resolve calls against, and which
 * nothing here had hardened before this revision.
 *
 * The header explains each value. Two of them are the reason this file had to
 * grow a second plan at all: `audio.noise_cancellation.mode` was `auto-on` and
 * `session.inactivity_timeout_seconds` was 30, both of which are Stream's
 * shipped defaults on a type whose events would have reached
 * `call.session_ended` handlers in `lib/stream/webhook-dispatch.ts` — the same
 * handler chain that #1277 had to make safe against a thirty-second room on
 * `default`, on a type where the thirty seconds was still in place.
 */
const LIVESTREAM_PLAN: CallTypePlan = {
  name: "livestream",
  rationale:
    "safe defaults for the day we migrate — a type nobody uses must not leak, and a type we do use must not be billed at 1080p with noise cancellation on",
  pins: [
    pin(
      "audio",
      "noise_cancellation",
      (s) => s.audio?.noise_cancellation,
      // A WHOLE `noise_cancellation` object rather than a mode string, because
      // that is the shape `audio.noise_cancellation` has on the wire: `mode` is
      // its only member today, and it is the key Stream expects in the payload.
      // Reading and targeting the same SHAPE is what lets the comparison below be
      // a value comparison; a pin that read `…?.mode` and targeted `{mode}` could
      // never compare equal, so the field would be re-sent on every run forever.
      { mode: "available" } satisfies { mode: NoiseCancellationMode },
      "audio.noise_cancellation.mode",
    ),
    pin(
      "frame_recording",
      "mode",
      (s) => s.frame_recording?.mode,
      "disabled" satisfies RecordingMode,
    ),
    pin(
      "individual_recording",
      "mode",
      (s) => s.individual_recording?.mode,
      "disabled" satisfies RecordingMode,
    ),
    pin(
      "raw_recording",
      "mode",
      (s) => s.raw_recording?.mode,
      "disabled" satisfies RecordingMode,
    ),
    pin("ingress", "enabled", (s) => s.ingress?.enabled, false),
    pin(
      "session",
      "inactivity_timeout_seconds",
      (s) => s.session?.inactivity_timeout_seconds,
      900,
    ),
    // WebinarPlan.maxParticipants defaults to 100; match the plan, not the guess.
    pin("limits", "max_participants", (s) => s.limits?.max_participants, 100),
    // File transcription: ~$8/1k call-min and a durable artefact nobody asked for.
    pin(
      "transcription",
      "mode",
      (s) => s.transcription?.mode,
      "disabled" satisfies TranscriptionMode,
    ),
    // Captions stay AVAILABLE — an accessibility feature a host opts into at
    // go-live, billed deliberately rather than by a participant. Pinned so the
    // decision is explicit and a dashboard edit un-makes it loudly.
    pin(
      "transcription",
      "closed_caption_mode",
      (s) => s.transcription?.closed_caption_mode,
      "available" satisfies TranscriptionMode,
    ),
    // Aligned to `default`. Stream bills AGGREGATED RECEIVED resolution and
    // cannot cap what a client sends, so a 1080p target here is a permanent 2x.
    pin(
      "video",
      "target_resolution",
      (s) => s.video?.target_resolution,
      { width: 1280, height: 720, bitrate: 1500000 },
      "video.target_resolution",
    ),
    // The one value on this type that is NOT Stream's default and must not go.
    // Pinned at its live value, so nothing is written and a dashboard edit
    // removing it is reported as drift rather than discovered during a live
    // broadcast: without backstage, "production" mints a call the audience can
    // walk into while the hosts are still waiting in the green room.
    pin("backstage", "enabled", (s) => s.backstage?.enabled, true),
    pin("recording", "mode", (s) => s.recording?.mode, "available"),
  ],
};

/**
 * The types this script owns, in the order it writes them.
 *
 * `default` first: if the run is going to be abandoned partway, it must be
 * abandoned having fixed the type every live consultation is sitting on.
 */
const PLANS: readonly CallTypePlan[] = [DEFAULT_PLAN, LIVESTREAM_PLAN];

/**
 * Why this run must not write, or `null`.
 *
 * B5. The three recording families this script disables are the ones nothing
 * calls; `recording.mode` is the one `lib/stream/recording-service.ts` always
 * needs, and this script never sets it. So the question is not "did I write the
 * right value" but "did I leave the load-bearing value usable" — and the answer
 * has to be derived from the COMPUTED target, not from the live read alone,
 * because the day someone adds a `recording` pin to a plan is the day the naive
 * version starts disagreeing with itself.
 *
 * Refusing rather than warning: the failure this guards is silent in the worst
 * way. The write succeeds, the script prints a green tick, and every
 * consultation for the rest of the day produces no recording file — discovered
 * by a customer who asked for the recording, which is the most expensive way to
 * find out and the one nobody is watching for.
 */
export function unusableRecordingMode(
  live: CallSettingsResponse,
  plan: CallTypePlan,
): string | null {
  const recordingPin = plan.pins.find(
    (p) => p.section === "recording" && p.field === "mode",
  );
  const computed = recordingPin ? recordingPin.target : live.recording?.mode;
  if (MODES_THAT_RECORD.includes(String(computed))) return null;
  return (
    `recording.mode would be ${String(computed)}, and the app records with ` +
    `recording_type "${RECORDING_TYPE}" — every consultation would produce no file`
  );
}

/**
 * Whether a pin is not yet at target.
 *
 * By VALUE, never by reference. Two pins target objects —
 * `audio.noise_cancellation` and `video.target_resolution` — and `!==` on two
 * structurally identical objects is `true`, so those two fields would be reported
 * as drifted, re-sent and re-verified on every single run, forever, and the
 * "already at the desired settings — no change" path could never be reached for
 * either call type. A drift gate that is always red trains people to ignore it,
 * which is the same conclusion the webhook gate reached the hard way.
 *
 * `canonical` rather than `JSON.stringify` for the same reason
 * `config-fingerprint.ts` uses it: two reads of the same document do not
 * guarantee the same key order, and a comparator that reports that as drift
 * tells an operator mid-incident that Stream discarded settings it never
 * touched.
 */
function offTarget(p: Pin, settings: CallSettingsResponse): boolean {
  return canonical(p.read(settings)) !== canonical(p.target);
}

/** `x.y: live -> target` for every pin that is not yet at target. */
function pendingLines(
  plan: CallTypePlan,
  settings: CallSettingsResponse,
): string[] {
  return plan.pins
    .filter((p) => offTarget(p, settings))
    .map(
      (p) =>
        `${name(p)}: ${JSON.stringify(p.read(settings))} -> ` +
        `${JSON.stringify(p.target)}`,
    );
}

/** The pins that are not yet at target, as sections ready to be sent. */
function pendingPins(
  plan: CallTypePlan,
  settings: CallSettingsResponse,
): Pin[] {
  return plan.pins.filter((p) => offTarget(p, settings));
}

/**
 * The write payload: only the sections being changed, each REBUILT from the
 * live read with the pinned field substituted.
 *
 * Sending `{}` for a section would be the tidier thing and Stream rejects it —
 * sub-objects are validated whole, so `audio` without `default_device` and
 * `frame_recording` without `capture_interval_in_seconds` both fail. Rebuilding
 * from the read is also what makes a pin safe to add: a plan cannot reset a
 * field it did not mention, so the "NOT changed here, deliberately" list in the
 * header is enforced by the shape of the code rather than by remembering.
 *
 * Overrides are COLLECTED before any base is spread, and that ordering is load-
 * bearing. Building each section from the live read and folding them in pin
 * order looks equivalent and is not: `livestream` pins two fields inside
 * `transcription`, and the second block built from the read still carries the
 * LIVE `mode`, so folding it over the first silently puts `mode` back to
 * `available`. The write would land, Stream would accept it, and the type would
 * keep billing file transcription.
 */
function payloadFor(
  plan: CallTypePlan,
  settings: CallSettingsResponse,
): Record<string, unknown> {
  const overrides: Record<string, Record<string, unknown>> = {};
  for (const p of pendingPins(plan, settings)) {
    overrides[p.section] = {
      ...(overrides[p.section] ?? {}),
      [p.field]: p.target,
    };
  }

  const out: Record<string, unknown> = {};
  for (const [section, override] of Object.entries(overrides)) {
    const base = (settings as unknown as Record<string, unknown>)[section];
    out[section] = {
      ...(base && typeof base === "object" ? base : {}),
      ...override,
    };
  }
  return out;
}

/** The report the operator reads, and the input to the drift annotation. */
function describe(
  plan: CallTypePlan,
  settings: CallSettingsResponse,
): string[] {
  return plan.pins.map((p) => {
    const value = p.read(settings);
    return (
      `${offTarget(p, settings) ? "  " : "✅"} ${name(p).padEnd(42)} = ` +
      `${JSON.stringify(value)}`
    );
  });
}

interface Options {
  apply: boolean;
  check: boolean;
  argv: readonly string[];
}

function parseArgs(argv: string[]): Options {
  return {
    apply: argv.includes("--apply"),
    check: argv.includes("--check"),
    argv,
  };
}

/**
 * One call type: read, report, refuse if the target is unusable, probe, write,
 * verify.
 */
async function applyPlan(
  client: ReturnType<typeof getStreamVideoClient>,
  plan: CallTypePlan,
  opts: Options,
): Promise<number> {
  const before = await client.video.getCallType({ name: plan.name });
  const settingsBefore = before.settings;
  const grantsBefore = canonical(before.grants);
  const notificationsBefore = canonical(before.notification_settings);
  const settingsCanonBefore = canonical(before.settings);

  console.log(
    `\n${"─".repeat(72)}\ncall type "${plan.name}" — ${plan.rationale}`,
  );
  console.log(`current:`);
  for (const line of describe(plan, settingsBefore)) console.log(`  ${line}`);

  const pending = pendingLines(plan, settingsBefore);
  const recordingFault = unusableRecordingMode(settingsBefore, plan);

  // The pre-write guard, BEFORE the drift report and before the pre-image. A
  // refusal has to be the first thing on the terminal: an operator who reads a
  // diff first has already decided the write is going ahead.
  if (recordingFault) {
    console.error(
      `\n🛑 Refusing to apply "${plan.name}" — ${recordingFault}.` +
        `\n   Nothing was written. The three families this script disables are` +
        `\n   unused; this one is not, and it is not this script's to set.` +
        `\n   Repair recording.mode in the Stream dashboard (or pin it here) and` +
        `\n   re-run.\n`,
    );
    return 1;
  }

  if (pending.length === 0) {
    console.log(`\n✅ already at the desired settings — no change`);
    return 0;
  }

  console.log(`\nPending changes:`);
  for (const line of pending) console.log(`  ${line}`);

  if (opts.check) {
    annotate(
      `Stream call-type settings drift on \`${plan.name}\`: ${pending.length} ` +
        `field(s) are not at the posture this app requires — ${pending.join("; ")}. ` +
        // #1829 — same gap as the grants annotation: a bare `--apply` is refused
        // by `requireNamedTargetApp`, so the printed remediation could not run.
        `Run: npx tsx scripts/stream/ensure-call-type-settings.ts --apply ` +
        `--target-app ${PRODUCTION_APP_NAME}.`,
    );
    console.log(`\n(check mode — no write; the job exits ${DRIFT_EXIT_CODE})`);
    return DRIFT_EXIT_CODE;
  }

  if (!opts.apply) {
    console.log("\n(dry run — re-run with --apply to write this to Stream)");
    return 0;
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  // `:` from toISOString is an illegal filename character on Windows, where
  // writeFileSync would throw before the probe had a chance to run.
  const stamp = new Date().toISOString().replace(/:/g, "-");
  const preImagePath = `${BACKUP_DIR}/call-type-${plan.name}.${stamp}.json`;
  writeFileSync(
    preImagePath,
    JSON.stringify(
      {
        settings: before.settings,
        grants: before.grants,
        notification_settings: before.notification_settings,
      },
      null,
      2,
    ),
  );
  console.log(`\nPre-image written to ${preImagePath}`);

  // Probe: write the values back unchanged, then check that nothing ELSE moved.
  // If `updateCallType` replaces rather than merges, this is where we find out —
  // with no semantic change of our own riding on it.
  //
  // `livestream` has never been probed. "Stream merges" was established for the
  // `default` document on 2026-08-30 and the two documents are not the same
  // object: `livestream` additionally carries a populated `broadcasting` block,
  // `ring` timeouts and an `ingress` encoder ladder that `default` does not, so
  // it is exactly the document a replace would damage differently.
  console.log("Probing merge-vs-replace with a no-op write...");
  await client.video.updateCallType({
    name: plan.name,
    settings: {
      // Spread rather than sending the one field: the probe must be a no-op, and
      // a partial sub-object is exactly what Stream rejects. This is still
      // semantically identical to the live value.
      session: {
        ...(settingsBefore.session ?? {}),
        inactivity_timeout_seconds:
          settingsBefore.session.inactivity_timeout_seconds,
      },
    } as never,
  });

  const probe = await client.video.getCallType({ name: plan.name });
  if (canonical(probe.grants) !== grantsBefore) {
    console.error(
      `\n🚨 GRANTS CHANGED after a no-op settings write. updateCallType REPLACES.` +
        `\n   Every role's permissions may be gone — this is a total video outage.` +
        `\n   Restore from: ${preImagePath}`,
    );
    return 1;
  }
  if (canonical(probe.settings) !== settingsCanonBefore) {
    console.error(
      `\n🚨 OTHER SETTINGS CHANGED after a no-op write — a partial settings payload` +
        `\n   does not merge. Do not proceed. Restore from: ${preImagePath}`,
    );
    return 1;
  }
  if (canonical(probe.notification_settings) !== notificationsBefore) {
    console.error(
      `\n🚨 notification_settings changed after a no-op write.` +
        `\n   Restore from: ${preImagePath}`,
    );
    return 1;
  }
  console.log(
    "  ✅ probe clean — partial settings writes merge, grants untouched",
  );

  await client.video.updateCallType({
    name: plan.name,
    settings: payloadFor(plan, settingsBefore) as never,
  });

  const after = await client.video.getCallType({ name: plan.name });

  console.log("\nAfter:");
  for (const line of describe(plan, after.settings)) console.log(`  ${line}`);

  if (canonical(after.grants) !== grantsBefore) {
    console.error(
      `\n🚨 GRANTS CHANGED. Restore immediately from ${preImagePath}`,
    );
    return 1;
  }
  console.log("\n✅ grants unchanged");

  // Assert against what Stream STORED, over every pin — not just the ones this
  // run happened to send. A pin that was already at target is a no-op, so
  // failing on it would be noise; a pin that moved and did not land is the whole
  // class of failure this file exists to make loud.
  const stillWrong = plan.pins
    .filter((p) => offTarget(p, after.settings))
    .map((p) => name(p));

  if (stillWrong.length > 0) {
    console.error(
      `\n⚠️ Stream did not store: ${stillWrong.join(", ")}. Investigate before trusting this run.`,
    );
    return 1;
  }

  // The post-write half of the B5 guard. The pre-write check proves the target
  // was usable; this proves it is STILL usable, which is a different question —
  // `updateCallType` is documented to merge at the top level and validated as a
  // whole at the sub-object level, and neither of those promises anything about
  // what a `recording` block it was not given looks like afterwards.
  const recordingAfter = unusableRecordingMode(after.settings, plan);
  if (recordingAfter) {
    console.error(
      `\n🚨 ${recordingAfter}.` +
        `\n   It was usable before this write and is not after it, so this write` +
        `\n   did something to a block it was not given.` +
        `\n   Restore immediately from ${preImagePath}`,
    );
    return 1;
  }

  console.log("✅ all settings stored as intended");
  return 0;
}

export async function ensureCallTypeSettings(
  opts: Options = { apply: false, check: false, argv: [] },
): Promise<number> {
  if (!isStreamConfigured()) {
    console.error(
      "Stream is not configured — set STREAM_API_KEY and STREAM_API_SECRET",
    );
    return 1;
  }

  const client = getStreamVideoClient();

  // One read, used twice: as the credential cross-check for the guard, and as
  // the header the operator reads to confirm which app is about to be written.
  // A failure here is a RUNNER problem, not drift — hence 1, not
  // DRIFT_EXIT_CODE, and a log reader should not have to guess the difference.
  const appName = (await client.getApp()).app?.name;

  if (
    !requireNamedTargetApp({
      script: "scripts/stream/ensure-call-type-settings.ts",
      writes: opts.apply,
      argv: opts.argv,
      // Free: the client is already open, so hand the guard the name these
      // credentials actually resolve to and get the half of the check a
      // declaration cannot make — credentials that are not ours, however
      // confidently they were named.
      liveAppName: appName,
    })
  ) {
    return 1;
  }

  // Two different rules, and the previous code applied the apply-mode rule to
  // both — which is why the comment below it contradicted the line above.
  let worst = 0;
  let failed = false;
  for (const plan of PLANS) {
    const code = await applyPlan(client, plan, opts);
    if (code === 1) {
      failed = true;
      // `--apply` stops here, and it must: `default` is first in PLANS, so a
      // failure on it means the load-bearing call type is not in the posture
      // this script exists to enforce, and continuing would write
      // `livestream` over the top of a half-applied run.
      if (opts.apply) return 1;
      // `--check` does NOT stop, because the comment below is right and the
      // code was wrong: a per-type failure must not hide the other type. The
      // failure is recorded and the loop continues, so the operator gets the
      // whole picture — including the case where `livestream` has drift the
      // daily job would otherwise never mention, because `default` happened to
      // fail first. A read-only job that reports one of two problems is
      // indistinguishable from a job that found one.
    }
    if (code === DRIFT_EXIT_CODE) worst = DRIFT_EXIT_CODE;
  }
  // A failure outranks drift in the exit code: 1 is a runner problem a human
  // must see, and `worst` would otherwise hide it behind a drift result.
  return failed ? 1 : worst;
}

if (require.main === module) {
  ensureCallTypeSettings(parseArgs(process.argv.slice(2)))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(
        "ensure-call-type-settings failed:",
        err instanceof Error ? err.message : err,
      );
      process.exitCode = 1;
    });
}
