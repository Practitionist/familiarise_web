"use client";

import { useState, useEffect } from "react";
import { Call, useStreamVideoClient } from "@stream-io/video-react-sdk";

import { streamLogger } from "@/lib/stream-logger";

export interface MeetingAccessResult {
  hasAccess: boolean;
  role: "host" | "participant" | null;
  message: string;
}

/**
 * Resolve the Stream call for a meeting id, gated by the server.
 *
 * #1134 P0-2 — this used to `client.queryCalls()` and, on a miss,
 * `client.call("default", callId).getOrCreate()`. That ran in PARALLEL with the
 * access check on the page, so any signed-in user who opened
 * `/meetings/<anything>` minted a billable Stream call and became its
 * `created_by` before being shown "Access Denied". Two such ghosts —
 * `default:smoke-test-nonexistent` and `default:test-meeting` — were still
 * sitting in the production app months later.
 *
 * The client no longer creates anything. It asks `/api/meetings/[id]/join`,
 * which grants call membership only after confirming the caller is on this
 * appointment. A non-participant gets a 403 with no Stream object created, and —
 * with `join-call` moved to `call_member` — could not join even holding a call
 * handle. `client.call()` below constructs a local object and writes nothing.
 */
export const useGetCallById = (callId: string) => {
  const [call, setCall] = useState<Call | null>(null);
  const [isCallLoading, setIsCallLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [access, setAccess] = useState<MeetingAccessResult | null>(null);
  const client = useStreamVideoClient();

  useEffect(() => {
    if (!callId) {
      setError(new Error("Call ID is required"));
      setIsCallLoading(false);
      return;
    }
    // The provider mounts the video client lazily, so `undefined` here is the
    // normal cold-load state, not a failure. Stay in `loading` and let the
    // effect re-run once the client lands — surfacing an error at this point
    // produced a visible "Video client not available" flash on every cold open.
    if (!client) return;

    // Guards a slow response for a previous `callId` from overwriting a newer
    // one, and a `setState` after unmount.
    let cancelled = false;

    const run = async () => {
      setIsCallLoading(true);
      setError(null);

      try {
        const response = await fetch(
          `/api/meetings/${encodeURIComponent(callId)}/join`,
          { method: "POST" },
        );

        if (cancelled) return;

        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          const message =
            typeof body?.error === "string"
              ? body.error
              : "Could not join this meeting.";

          // Only an authorization verdict is an access denial. Everything else
          // — Stream down (503), a server fault (500), a bad id (400) — used to
          // land here too and render as "You are not authorized to join this
          // meeting", telling a legitimate participant they had been refused
          // when the truth was an outage. The join route stamps `reason` on a
          // real refusal and on nothing else, so that is the discriminator.
          const refused =
            response.status === 401 ||
            response.status === 403 ||
            response.status === 404;

          if (refused) {
            setAccess({ hasAccess: false, role: null, message });
            setCall(null);
            // Not an `error`: a refusal is an expected outcome with its own UI,
            // and rendering it as a crash lost the reason.
            return;
          }

          // A failure, not a verdict. Surfacing it as an error gets the retry
          // affordance instead of a dead-end "access denied" screen.
          throw new Error(message);
        }

        const data = (await response.json()) as {
          callType: string;
          callId: string;
          role: "host" | "participant";
        };

        if (cancelled) return;

        // `client.call()` only constructs the local handle — it performs no
        // network write, so nothing is created for a caller who got this far.
        const callInstance = client.call(data.callType, data.callId);
        await callInstance.get();

        if (cancelled) return;

        setAccess({
          hasAccess: true,
          role: data.role,
          message: "Access granted",
        });
        setCall(callInstance);
      } catch (err) {
        if (cancelled) return;
        streamLogger.error("Failed to resolve meeting call", err, { callId });
        setError(err instanceof Error ? err : new Error("Failed to get call"));
        setCall(null);
      } finally {
        if (!cancelled) setIsCallLoading(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [client, callId]);

  return { call, isCallLoading, error, access };
};
