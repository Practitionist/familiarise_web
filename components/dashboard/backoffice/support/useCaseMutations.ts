"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useToast } from "@/hooks/use-toast";
import { throwSupportError } from "@/lib/support/error-copy";
import type { CaseWorkspace } from "@/types/support-case";

async function send(url: string, method: "POST" | "PATCH", body: object) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwSupportError(res, `${method} ${url}`);
}

/**
 * #1527 — every write from the case workspace, through the EXISTING routes
 * and their guards: a ticket case uses the ticket routes (which mirror into
 * its thread), a conversation that was never escalated uses the thread route.
 */
export function useCaseMutations(c: CaseWorkspace | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const ticketUrl = c?.ticketId && `/api/staff/support-tickets/${c.ticketId}`;
  const threadUrl = c?.threadId && `/api/staff/support-threads/${c.threadId}`;

  const settle = (title: string) => ({
    onSuccess: () => {
      toast({ title });
      for (const key of [
        ["support-case", c?.key],
        ["support-inbox"],
        ["support-inbox-stats"],
        ["backoffice-nav-counts"],
      ]) {
        void qc.invalidateQueries({ queryKey: key });
      }
    },
    onError: (e: unknown) =>
      toast({
        title: "That didn't go through",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      }),
  });

  const reply = useMutation({
    mutationFn: async ({
      message,
      note,
    }: {
      message: string;
      note: boolean;
    }) => {
      if (ticketUrl) {
        return send(`${ticketUrl}/responses`, "POST", {
          message,
          isInternal: note,
        });
      }
      // A private note needs a ticket to live on; the composer never offers
      // one without it, and this refuses rather than send it to the user.
      if (note || !threadUrl) throw new Error("Private notes need a ticket");
      return send(threadUrl, "POST", { message });
    },
    ...settle("Sent"),
  });

  const setStatus = useMutation({
    mutationFn: (status: "IN_PROGRESS" | "RESOLVED" | "CLOSED") =>
      ticketUrl
        ? send(ticketUrl, "PATCH", { status })
        : send(threadUrl as string, "PATCH", { status }),
    ...settle("Status updated"),
  });

  const update = useMutation({
    mutationFn: (patch: { assignedToId?: string | null; priority?: string }) =>
      send(ticketUrl as string, "PATCH", patch),
    ...settle("Case updated"),
  });

  return { reply, setStatus, update };
}
