"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  FileActionError,
  friendlyErrorFromResponse,
} from "@/lib/documents/file-errors";
import { formatOperatorInstant } from "@/lib/time/operator-zone";

const ThreadsSchema = z.object({
  threads: z.array(
    z.object({
      rootId: z.string(),
      title: z.string(),
      uploadedBy: z.enum(["learner", "expert"]),
      uploadedAt: z.string(),
      versions: z.number(),
      removalRequestedAt: z.string().nullable(),
    }),
  ),
});

type RemovalAction =
  | { action: "remove"; reason: "USER_REQUEST" | "SUPPORT_ACTION" }
  | { action: "decline" };

/**
 * A booking's document threads for support: remove a thread (the reason is
 * recorded and the files are purged after the grace window) or decline a
 * learner's removal request.
 */
export function BookingDocumentsOps({
  appointmentId,
}: Readonly<{ appointmentId: string }>) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const key = ["booking-ops", appointmentId, "documents"] as const;
  const threads = useQuery({
    queryKey: key,
    queryFn: async () => {
      const res = await fetch(
        `/api/staff/appointments/${encodeURIComponent(appointmentId)}/documents`,
      );
      if (!res.ok) throw new Error("Failed to load");
      const parsed = ThreadsSchema.safeParse(await res.json());
      if (!parsed.success) throw new Error("Unexpected response");
      return parsed.data.threads;
    },
  });
  const act = useMutation({
    mutationFn: async (args: { rootId: string; body: RemovalAction }) => {
      const res = await fetch(
        `/api/staff/appointments/${encodeURIComponent(appointmentId)}/documents/${encodeURIComponent(args.rootId)}/removal`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args.body),
        },
      );
      if (!res.ok) {
        throw new FileActionError(await friendlyErrorFromResponse(res));
      }
    },
    onSuccess: (_data, args) => {
      toast({
        title:
          args.body.action === "decline"
            ? "Removal request declined"
            : "Document removed",
      });
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) =>
      toast({
        title:
          error instanceof FileActionError ? error.title : "That didn't work",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      }),
  });

  if (!threads.data) {
    return (
      <p className="text-sm text-muted-foreground">
        {threads.isError
          ? "Documents could not be loaded."
          : "Loading documents…"}
      </p>
    );
  }
  if (threads.data.length === 0) return null;

  return (
    <div className="space-y-1 text-sm">
      <p className="font-medium">Session documents</p>
      <ul className="divide-y divide-border rounded-md border">
        {threads.data.map((t) => (
          <li
            key={t.rootId}
            className="flex flex-wrap items-center justify-between gap-2 p-2"
          >
            <span className="min-w-0 flex-1">
              {t.title} · from the {t.uploadedBy} · {t.versions}{" "}
              {t.versions === 1 ? "version" : "versions"}
              {t.removalRequestedAt
                ? ` · removal requested ${formatOperatorInstant(t.removalRequestedAt)}`
                : ""}
            </span>
            <span className="flex flex-wrap gap-1.5">
              {t.removalRequestedAt ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={act.isPending}
                    onClick={() =>
                      act.mutate({
                        rootId: t.rootId,
                        body: { action: "remove", reason: "USER_REQUEST" },
                      })
                    }
                  >
                    Remove document
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={act.isPending}
                    onClick={() =>
                      act.mutate({
                        rootId: t.rootId,
                        body: { action: "decline" },
                      })
                    }
                  >
                    Decline
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={act.isPending}
                  onClick={() =>
                    act.mutate({
                      rootId: t.rootId,
                      body: { action: "remove", reason: "SUPPORT_ACTION" },
                    })
                  }
                >
                  Remove as support
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
