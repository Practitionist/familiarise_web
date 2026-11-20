"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useToast } from "@/hooks/use-toast";
import { fetchWithReauth } from "@/lib/auth/reauth-client";

/** #1771 K-1 — a door's typed refusal, with the code the route answered. */
export class OpsDoorError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** POSTs one console door; a refusal throws with the route's own copy. */
export async function callOpsDoor(
  url: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetchWithReauth(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new OpsDoorError(
      typeof json.error === "string" ? json.error : "The action failed.",
      typeof json.code === "string" ? json.code : "FAILED",
    );
  }
  return json;
}

/** Above ₹25,000 with two admins, a money door answers 202 and waits for another admin. */
export const PROPOSED_TOAST = "Sent to another admin for approval";

export function isProposed(data: Record<string, unknown>): boolean {
  return data.status === "PROPOSED";
}

/** A door as a mutation: toasts the outcome and refreshes the given reads. */
export function useOpsDoor(opts: {
  /** The success toast, or how to word it from the route's answer. */
  success: string | ((data: Record<string, unknown>) => string);
  invalidate: readonly (readonly unknown[])[];
  onDone?: (data: Record<string, unknown>) => void;
  onFailed?: () => void;
  /** A door's own copy for a refusal code, in place of the route's message. */
  refusalCopy?: Readonly<Record<string, string>>;
  /** The refusal toast's title; names the action that did not go through. */
  failure?: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      url,
      body,
    }: {
      url: string;
      body: Record<string, unknown>;
    }) => callOpsDoor(url, body),
    onSuccess: (data) => {
      const done =
        typeof opts.success === "string" ? opts.success : opts.success(data);
      toast({ title: isProposed(data) ? PROPOSED_TOAST : done });
      opts.onDone?.(data);
    },
    onError: (err: Error) => {
      toast({
        title: opts.failure ?? "That action didn't go through",
        description:
          (err instanceof OpsDoorError && opts.refusalCopy?.[err.code]) ||
          err.message,
        variant: "destructive",
      });
      opts.onFailed?.();
    },
    // A refused door can still have moved state (a failed approval stays APPROVED).
    onSettled: () => {
      for (const key of opts.invalidate)
        void queryClient.invalidateQueries({ queryKey: [...key] });
    },
  });
}
