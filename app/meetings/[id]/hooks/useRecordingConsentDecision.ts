"use client";

import { useCallback, useRef, useState } from "react";
import { z } from "zod";

import { toast } from "@/components/ui/use-toast";

export type RecordingConsentChoice = "GRANTED" | "DECLINED";

export type RecordingConsentResult =
  { ok: true; recordingStopped: boolean } | { ok: false; error: string };

const successSchema = z.object({ recordingStopped: z.boolean().optional() });
const errorSchema = z.object({ error: z.string() });

const FALLBACK_ERROR = "Could not save your choice. Please try again.";

/** Posts this viewer's recording decision for a Stream call; one request in flight at a time. */
export function useRecordingConsentDecision(callId: string) {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  /** Resolves `null` when a decision is already in flight. */
  const submit = useCallback(
    async (
      decision: RecordingConsentChoice,
    ): Promise<RecordingConsentResult | null> => {
      if (inFlight.current) return null;
      inFlight.current = true;
      setPending(true);
      try {
        const res = await fetch(
          `/api/meetings/${encodeURIComponent(callId)}/recording-consent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision }),
          },
        );
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          const parsed = errorSchema.safeParse(body);
          return {
            ok: false,
            error: parsed.success ? parsed.data.error : FALLBACK_ERROR,
          };
        }
        const parsed = successSchema.safeParse(body);
        const recordingStopped =
          parsed.success && parsed.data.recordingStopped === true;
        // The in-call stop toast is neutral; only the decliner learns it will be discarded.
        if (recordingStopped) {
          toast({
            title: "Recording stopped",
            description: "It will be discarded at your request.",
          });
        }
        return { ok: true, recordingStopped };
      } catch {
        return { ok: false, error: FALLBACK_ERROR };
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
    [callId],
  );

  return { submit, pending };
}
