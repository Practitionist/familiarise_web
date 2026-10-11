"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useToast } from "@/hooks/use-toast";
import { isStaleCaseError, throwSupportError } from "@/lib/support/error-copy";
import type { CaseWorkspace } from "@/types/support-case";

async function send(url: string, method: "POST" | "PATCH", body: object) {
  if (!url) {
    throw new Error("Missing case endpoint URL");
  }
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

  const settle = (
    title: string,
    conflictMessage?: { title: string; description: string },
  ) => ({
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
    onError: (e: unknown) => {
      if (isStaleCaseError(e)) {
        void qc.invalidateQueries({ queryKey: ["support-case", c?.key] });
        toast({
          title:
            conflictMessage?.title ?? "The case changed — review and retry",
          description:
            conflictMessage?.description ??
            "We loaded the latest version of this case.",
        });
        return;
      }
      toast({
        title: "That didn't go through",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    },
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
          ...(note || !c?.lastMessageAt
            ? {}
            : { expectedLastMessageAt: c.lastMessageAt }),
        });
      }
      if (note || !threadUrl) throw new Error("Private notes need a ticket");
      return send(threadUrl, "POST", { message });
    },
    ...settle("Sent", {
      title: "New message arrived before your send",
      description:
        "A new message or update landed on this case while you were typing. Read it before sending.",
    }),
  });

  const key = c?.key;

  const setStatus = useMutation({
    mutationFn: (status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED") => {
      const expectedUpdatedAt =
        qc.getQueryData<CaseWorkspace>(["support-case", key])?.updatedAt ??
        c?.updatedAt;
      return ticketUrl
        ? send(ticketUrl, "PATCH", {
            status,
            expectedUpdatedAt,
          })
        : send(threadUrl ?? "", "PATCH", { status });
    },
    ...settle("Status updated"),
  });

  const update = useMutation({
    mutationFn: (patch: {
      assignedToId?: string | null;
      priority?: string;
      note?: string;
    }) => {
      const expectedUpdatedAt =
        qc.getQueryData<CaseWorkspace>(["support-case", key])?.updatedAt ??
        c?.updatedAt;
      return send(ticketUrl ?? "", "PATCH", {
        ...patch,
        expectedUpdatedAt,
      });
    },
    ...settle("Case updated"),
  });

  return { reply, setStatus, update };
}
