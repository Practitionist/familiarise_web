"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { libraryKeys, recordingKeys } from "@/lib/documents/query-keys";
import { LibraryBrowser } from "./LibraryBrowser";

const SyncResultSchema = z.object({ synced: z.number().optional() });

/** Pulls recordings Stream has finished but the webhook has not delivered yet. */
function SyncFromStream() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={syncing}
      onClick={async () => {
        setSyncing(true);
        try {
          const res = await fetch("/api/stream/recordings/sync", {
            method: "POST",
          });
          if (!res.ok) throw new Error("sync failed");
          const parsed = SyncResultSchema.safeParse(await res.json());
          const synced = parsed.success ? (parsed.data.synced ?? 0) : 0;
          toast({
            title: synced > 0 ? "Recordings synced" : "Up to date",
            description:
              synced > 0
                ? `${synced} recording(s) added.`
                : "No new recordings were found.",
          });
          await queryClient.invalidateQueries({
            queryKey: recordingKeys.library(),
          });
        } catch {
          toast({
            title: "Couldn't sync",
            description: "Try again in a moment.",
            variant: "destructive",
          });
        } finally {
          setSyncing(false);
        }
      }}
    >
      <RefreshCw
        className={`mr-1.5 h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`}
        aria-hidden
      />
      Sync from Stream
    </Button>
  );
}

/** The personal Documents or Recordings library for either side of the dashboard. */
export function PersonalLibrary({
  tree,
  profileId,
  artifact,
}: Readonly<{
  tree: "consultee" | "consultant";
  profileId: string;
  artifact: "documents" | "recordings";
}>) {
  const base = `/dashboard/${tree}/${profileId}`;
  const learner = tree === "consultee";
  return (
    <LibraryBrowser
      artifact={artifact}
      endpoint={`/api/dashboard/${tree}/${profileId}/${artifact}`}
      queryKey={libraryKeys.personal(artifact, tree, profileId)}
      sessionHref={(id) => `${base}/appointments/${id}/${artifact}`}
      sources={
        artifact === "documents"
          ? learner
            ? ["materials", "mine", "expert"]
            : ["materials", "mine", "learner"]
          : undefined
      }
      personLabel={learner ? "Expert" : "Learner"}
      emptyDescription={
        artifact === "documents"
          ? learner
            ? "Files you share with your experts, and their replies, appear here."
            : "Files your learners share, and your replies, appear here."
          : "Recorded sessions appear here after processing."
      }
      actions={
        !learner && artifact === "recordings" ? <SyncFromStream /> : null
      }
    />
  );
}
