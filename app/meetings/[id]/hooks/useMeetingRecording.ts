"use client";

import { useState, useEffect } from "react";
import { z } from "zod";

interface MeetingRecordingData {
  meetingId: string | null;
  recordingEnabled: boolean;
  isLoading: boolean;
  error: string | null;
}

const recordingInfoSchema = z.object({
  meetingId: z.string().nullable(),
  recordingEnabled: z.boolean(),
});

const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 30_000;

/** Capped exponential backoff; a transient failure keeps retrying at the cap until the room unmounts. */
export function recordingInfoRetryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS);
}

/** Server faults, rate limits and timeouts may clear on their own; any other status is a verdict. */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

/**
 * Fetches the session's recording flag for the host controls. A transient failure
 * never clears a value already known: the Record button must survive a blip.
 * @param streamCallId The Stream call ID
 */
export function useMeetingRecording(
  streamCallId: string | undefined,
): MeetingRecordingData {
  const [data, setData] = useState<MeetingRecordingData>({
    meetingId: null,
    recordingEnabled: false,
    isLoading: true,
    error: null,
  });

  useEffect(() => {
    if (!streamCallId) {
      setData((prev) => ({ ...prev, isLoading: false }));
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const fetchMeeting = async (attempt: number) => {
      try {
        const response = await fetch(
          `/api/stream/meetings/${encodeURIComponent(streamCallId)}/recording-info`,
        );
        if (cancelled) return;

        if (response.ok) {
          const parsed = recordingInfoSchema.parse(await response.json());
          if (cancelled) return;
          setData({ ...parsed, isLoading: false, error: null });
          return;
        }

        if (!isTransientStatus(response.status)) {
          // 404 and the auth refusals are verdicts: recording is not available here.
          setData({
            meetingId: null,
            recordingEnabled: false,
            isLoading: false,
            error: null,
          });
          return;
        }
        throw new Error("Failed to fetch meeting recording info");
      } catch (error) {
        if (cancelled) return;
        console.error("Error fetching meeting recording info:", error);
        // Keep the last known meeting and flag; only the error text changes.
        setData((prev) => ({
          ...prev,
          isLoading: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to fetch recording info",
        }));
        timer = setTimeout(
          () => void fetchMeeting(attempt + 1),
          recordingInfoRetryDelayMs(attempt),
        );
      }
    };

    void fetchMeeting(0);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [streamCallId]);

  return data;
}
