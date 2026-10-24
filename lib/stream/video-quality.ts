import { z } from "zod";

/** Call and screen-share resolutions staff may choose; no 4K, and Stream recording tops out at 1440p. */
export const CALL_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
export const RECORDING_QUALITIES = ["720p", "1080p"] as const;
export const SCREENSHARE_RESOLUTIONS = ["720p", "1080p"] as const;

const callResolutionSchema = z.enum(CALL_RESOLUTIONS);
const recordingQualitySchema = z.enum(RECORDING_QUALITIES);
const screenshareResolutionSchema = z.enum(SCREENSHARE_RESOLUTIONS);

export const DEFAULT_VIDEO_CONFIG = {
  callTargetResolution: "720p",
  recordingQuality: "720p",
  screenshareTargetResolution: "1080p",
} as const;

/** The staff edit body's fields, all optional; the door refuses an empty patch. */
export const videoConfigPatchShape = {
  callTargetResolution: callResolutionSchema.optional(),
  recordingQuality: recordingQualitySchema.optional(),
  screenshareTargetResolution: screenshareResolutionSchema.optional(),
};

/** A stored value the code no longer knows reads as its default rather than failing a call. */
export const storedVideoConfigSchema = z.object({
  callTargetResolution: callResolutionSchema.catch(
    DEFAULT_VIDEO_CONFIG.callTargetResolution,
  ),
  recordingQuality: recordingQualitySchema.catch(
    DEFAULT_VIDEO_CONFIG.recordingQuality,
  ),
  screenshareTargetResolution: screenshareResolutionSchema.catch(
    DEFAULT_VIDEO_CONFIG.screenshareTargetResolution,
  ),
});

export type PlatformVideoConfig = z.infer<typeof storedVideoConfigSchema>;
export type CallResolution = z.infer<typeof callResolutionSchema>;
export type RecordingQuality = z.infer<typeof recordingQualitySchema>;

/** Stream `target_resolution` for each key (1280x720 at 1.5 Mbps, 1920x1080 at 3 Mbps). */
export const TARGET_RESOLUTIONS: Record<
  CallResolution,
  { width: number; height: number; bitrate: number }
> = {
  "480p": { width: 640, height: 480, bitrate: 750_000 },
  "720p": { width: 1280, height: 720, bitrate: 1_500_000 },
  "1080p": { width: 1920, height: 1080, bitrate: 3_000_000 },
};

/** Cost per option for the staff form; sourced from Stream's pricing page. */
export const VIDEO_COST_HINTS = {
  call: {
    "480p": "Received video is billed at $0.75 per 1,000 participant-minutes.",
    "720p": "Received video is billed at $1.50 per 1,000 participant-minutes.",
    "1080p":
      "Received video is billed at $3.00 per 1,000 participant-minutes, twice the 720p rate.",
  },
  recording: {
    "720p": "HD recording is billed at $6 per 1,000 call-minutes.",
    "1080p": "Full HD recording is billed at $12 per 1,000 call-minutes.",
  },
  screenshare: {
    "720p":
      "Uses less bandwidth, but small text on a shared screen is harder to read.",
    "1080p":
      "Keeps small text on a shared screen readable; it counts as received video.",
  },
} as const;
