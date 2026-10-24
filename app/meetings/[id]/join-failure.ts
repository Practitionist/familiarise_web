import { SfuModels } from "@stream-io/video-react-sdk";
import { z } from "zod";

/** Why a join did not complete; a typed server refusal (401/403/404) is not a failure and never reaches this. */
export type JoinFailureKind = "provider_unavailable" | "room_full" | "unknown";

export interface JoinFailure {
  kind: JoinFailureKind;
  message: string;
}

/** The video client never arrived inside the bounded wait. */
export class VideoClientTimeoutError extends Error {
  constructor() {
    super(
      "Could not connect to the video service. Check your connection and try again.",
    );
    this.name = "VideoClientTimeoutError";
  }
}

/** The join route answered with a non-refusal HTTP status. */
export class JoinHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "JoinHttpError";
  }
}

const sfuJoinErrorSchema = z.object({
  errorEvent: z.object({ error: z.object({ code: z.number() }) }),
});
const statusErrorSchema = z.object({ status: z.number() });

const ROOM_FULL_MESSAGE_PATTERN =
  /participant limit|max(imum)? participants|call is full|room is full/i;
const NETWORK_MESSAGE_PATTERN =
  /failed to fetch|networkerror|network request failed|load failed|timed? ?out/i;

/** Retryable server states: bad gateway, unavailable, gateway timeout and rate limiting. */
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 502;
}

/**
 * Sorts a join error into the face the room shows. Stream's SFU refuses a full
 * call with `CALL_PARTICIPANT_LIMIT_REACHED`; the message match covers the
 * coordinator path, whose error shape is not documented.
 */
export function classifyJoinFailure(error: unknown): JoinFailureKind {
  const sfu = sfuJoinErrorSchema.safeParse(error);
  if (
    sfu.success &&
    sfu.data.errorEvent.error.code ===
      SfuModels.ErrorCode.CALL_PARTICIPANT_LIMIT_REACHED
  ) {
    return "room_full";
  }

  const message = error instanceof Error ? error.message : "";
  if (ROOM_FULL_MESSAGE_PATTERN.test(message)) return "room_full";

  if (error instanceof VideoClientTimeoutError) return "provider_unavailable";
  // `fetch` rejects with a TypeError when the network is down.
  if (error instanceof TypeError) return "provider_unavailable";
  const status = statusErrorSchema.safeParse(error);
  if (status.success) {
    return isTransientStatus(status.data.status)
      ? "provider_unavailable"
      : "unknown";
  }
  if (sfu.success) return "provider_unavailable";
  return NETWORK_MESSAGE_PATTERN.test(message)
    ? "provider_unavailable"
    : "unknown";
}

export function toJoinFailure(error: unknown): JoinFailure {
  return {
    kind: classifyJoinFailure(error),
    message:
      error instanceof Error && error.message
        ? error.message
        : "Failed to get call",
  };
}

export const MAX_PROVIDER_AUTO_RETRIES = 4;
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 30_000;

/** Exponential backoff capped at 30 s, scaled by 50-100% jitter so a recovering provider is not hit in lockstep. */
export function providerRetryDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS);
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

export const JOIN_FAILURE_COPY: Record<
  JoinFailureKind,
  { title: string; guidance: string }
> = {
  provider_unavailable: {
    title: "Video provider unavailable",
    guidance:
      "Our video provider is having trouble. Your session is protected — if it can't start, you'll be offered a reschedule or refund.",
  },
  room_full: {
    title: "This session is full",
    guidance:
      "This session is full. If you're already in it on another device, close that tab and try again.",
  },
  unknown: {
    title: "Couldn't join the session",
    guidance:
      "Something went wrong while joining. Try again; if it keeps happening, contact support from your appointment page.",
  },
};
