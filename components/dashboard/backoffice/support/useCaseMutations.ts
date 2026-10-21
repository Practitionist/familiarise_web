"use client";

import { useRef } from "react";
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

export function useCaseMutations(c: CaseWorkspace | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const pendingTurns = useRef(new Map<string, string>());
  const caseUrl = c?.caseId ? `/api/support/cases/${c.caseId}` : "";

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
      const turnKey = `${c?.caseId}:${note}:${message}`;
      const clientTurnId =
        pendingTurns.current.get(turnKey) ?? crypto.randomUUID();
      pendingTurns.current.set(turnKey, clientTurnId);
      await send(`${caseUrl}/messages`, "POST", {
        body: message,
        isInternal: note,
        clientTurnId,
        ...(note || !c?.lastMessageAt
          ? {}
          : { expectedLastMessageAt: c.lastMessageAt }),
      });
      pendingTurns.current.delete(turnKey);
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
      return send(caseUrl, "PATCH", { status, expectedUpdatedAt });
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
      return send(caseUrl, "PATCH", {
        ...patch,
        expectedUpdatedAt,
      });
    },
    ...settle("Case updated"),
  });

  return { reply, setStatus, update };
}
