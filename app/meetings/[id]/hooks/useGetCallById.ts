"use client";

import { useState, useEffect } from "react";
import { Call, useStreamVideoClient } from "@stream-io/video-react-sdk";

export const useGetCallById = (callId: string) => {
  const [call, setCall] = useState<Call | null>(null);
  const [isCallLoading, setIsCallLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const client = useStreamVideoClient();

  useEffect(() => {
    const getCall = async () => {
      if (!client || !callId) {
        setIsCallLoading(false);
        return;
      }

      try {
        setIsCallLoading(true);

        // First try to query for the call to find it regardless of type
        const { calls } = await client.queryCalls({
          filter_conditions: { id: callId },
        });

        if (calls.length > 0) {
          // If found via query, use the first match
          setCall(calls[0]);
        } else {
          // If not found, try to create it with default type
          const callInstance = client.call("default", callId);
          await callInstance.getOrCreate();
          setCall(callInstance);
        }
      } catch (err) {
        console.error("Error getting call:", err);
        setError(err instanceof Error ? err : new Error("Failed to get call"));
      } finally {
        setIsCallLoading(false);
      }
    };

    getCall();
  }, [client, callId]);

  return { call, isCallLoading, error };
};
