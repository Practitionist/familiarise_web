"use client";

import { useState, useEffect } from "react";
import { Call, useStreamVideoClient } from "@stream-io/video-react-sdk";

/**
 * @param callId  Stream call id from the meeting URL.
 * @param organizationId  Optional — when provided, stamped onto the Stream
 *   call's `custom.organizationId` if this hook has to create the call
 *   itself (the fallback below). The canonical creation path is
 *   server-side in `lib/meeting.ts`, which already stamps the metadata;
 *   this fallback only fires for stray/bookmarked meeting URLs where the
 *   server never minted the call. Callers with access to org context
 *   (e.g. via /api/meetings/[id]/validate-access) should pass it through
 *   so org-scoped dashboards stay consistent.
 */
export const useGetCallById = (callId: string, organizationId?: string) => {
  const [call, setCall] = useState<Call | null>(null);
  const [isCallLoading, setIsCallLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const client = useStreamVideoClient();

  useEffect(() => {
    const getCall = async () => {
      if (!client) {
        console.error(
          "StreamVideoClient not available - StreamProvider may be missing",
        );
        setError(new Error("Video client not available"));
        setIsCallLoading(false);
        return;
      }

      if (!callId) {
        console.error("Call ID is required");
        setError(new Error("Call ID is required"));
        setIsCallLoading(false);
        return;
      }

      try {
        setIsCallLoading(true);
        setError(null);
        console.log(`Attempting to get call with ID: ${callId}`);

        // First try to query for the call to find it regardless of type
        const { calls } = await client.queryCalls({
          filter_conditions: { id: callId },
        });

        console.log(
          `Query result: found ${calls.length} calls for ID ${callId}`,
        );

        if (calls.length > 0) {
          // If found via query, use the first match
          console.log(
            `Using existing call: ${calls[0].id} (type: ${calls[0].type})`,
          );
          setCall(calls[0]);
        } else {
          // If not found, try to create it with default type
          console.log(`Creating new call with ID: ${callId}`);
          const callInstance = client.call("default", callId);
          await callInstance.getOrCreate(
            organizationId
              ? { data: { custom: { organizationId } } }
              : undefined,
          );
          console.log(
            `Successfully created/retrieved call: ${callInstance.id}`,
          );
          setCall(callInstance);
        }
      } catch (err) {
        console.error("Error getting call:", err);
        console.error("Call ID:", callId);
        console.error("Client available:", !!client);
        setError(err instanceof Error ? err : new Error("Failed to get call"));
        setCall(null);
      } finally {
        setIsCallLoading(false);
      }
    };

    getCall();
  }, [client, callId, organizationId]);

  return { call, isCallLoading, error };
};
