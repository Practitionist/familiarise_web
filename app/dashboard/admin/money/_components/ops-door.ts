"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useToast } from "@/hooks/use-toast";

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
  const res = await fetch(url, {
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

/** A door as a mutation: toasts the outcome and refreshes the given reads. */
export function useOpsDoor(opts: {
  success: string;
  invalidate: readonly (readonly unknown[])[];
  onDone?: (data: Record<string, unknown>) => void;
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
      toast({ title: opts.success });
      for (const key of opts.invalidate)
        void queryClient.invalidateQueries({ queryKey: [...key] });
      opts.onDone?.(data);
    },
    onError: (err: Error) =>
      toast({
        title: "Not done",
        description: err.message,
        variant: "destructive",
      }),
  });
}
