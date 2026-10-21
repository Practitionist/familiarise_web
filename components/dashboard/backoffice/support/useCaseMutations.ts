"use client";

import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { freshCaseUpdatedAt } from "@/components/support/resolution/resolution-data";
import { useToast } from "@/hooks/use-toast";
import { isStaleCaseError, throwSupportError } from "@/lib/support/error-copy";
import { invalidateSupportCase } from "@/lib/support/support-keys";
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
  const caseId = c?.caseId;
  const caseUrl = caseId ? `/api/support/cases/${caseId}` : "";

  const refresh = () => {
    if (caseId) void invalidateSupportCase(qc, caseId);
    void qc.invalidateQueries({ queryKey: ["backoffice-nav-counts"] });
  };

  const settle = (
    title: string,
    conflictMessage?: { title: string; description: string },
  ) => ({
    onSuccess: () => {
      toast({ title });
      refresh();
    },
    onError: (e: unknown) => {
      if (isStaleCaseError(e)) {
        refresh();
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

  const expectedUpdatedAt = async () =>
    (caseId ? await freshCaseUpdatedAt(qc, caseId) : undefined) ?? c?.updatedAt;

  const reply = useMutation({
    mutationFn: async ({
      message,
      note,
    }: {
      message: string;
      note: boolean;
    }) => {
      const turnKey = `${caseId}:${note}:${message}`;
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

  const setStatus = useMutation({
    mutationFn: async (
      status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED",
    ) =>
      send(caseUrl, "PATCH", {
        status,
        expectedUpdatedAt: await expectedUpdatedAt(),
      }),
    ...settle("Status updated"),
  });

  const update = useMutation({
    mutationFn: async (patch: {
      assignedToId?: string | null;
      priority?: string;
      note?: string;
    }) =>
      send(caseUrl, "PATCH", {
        ...patch,
        expectedUpdatedAt: await expectedUpdatedAt(),
      }),
    ...settle("Case updated"),
  });

  return { reply, setStatus, update };
}
