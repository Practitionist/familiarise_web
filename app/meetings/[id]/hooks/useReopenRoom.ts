"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";

const reopenResponseSchema = z.object({
  streamCallId: z.string().optional(),
  error: z.string().optional(),
});

/** Host reopen of a sealed room on a fresh call id; the route enforces role, window and end-reason policy. */
export function useReopenRoom(meetingId: string) {
  const router = useRouter();
  const [isReopening, setIsReopening] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);

  const reopenRoom = useCallback(async () => {
    setReopenError(null);
    setIsReopening(true);
    try {
      const res = await fetch(
        `/api/meetings/${encodeURIComponent(meetingId)}/reopen`,
        { method: "POST" },
      );
      const parsed = reopenResponseSchema.safeParse(
        await res.json().catch(() => ({})),
      );
      const data = parsed.success ? parsed.data : {};
      if (!res.ok || !data.streamCallId) {
        setReopenError(
          data.error ?? "Could not reopen session room. Please try again.",
        );
        setIsReopening(false);
        return;
      }
      // The same call id means the room is not sealed yet; replacing to the current path would not remount.
      if (data.streamCallId === meetingId) {
        setReopenError(
          "The room is not marked as closed yet. Try again in a moment.",
        );
        setIsReopening(false);
        return;
      }
      router.replace(`/meetings/${encodeURIComponent(data.streamCallId)}`);
    } catch {
      setReopenError("Network error while reopening session room.");
      setIsReopening(false);
    }
  }, [meetingId, router]);

  return { reopenRoom, isReopening, reopenError };
}
