"use client";

import Link from "next/link";
import { useEffect, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileText, Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/dashboard/EmptyState";
import {
  FileActionError,
  friendlyErrorFromResponse,
  friendlyFileError,
} from "@/lib/documents/file-errors";
import {
  documentKeys,
  invalidateDocumentReads,
} from "@/lib/documents/query-keys";
import { readOnlyNotice, windowNotice } from "@/lib/documents/thread-copy";
import {
  threadNeedsViewer,
  type ThreadView,
} from "@/lib/documents/thread-view";
import type { DocumentWorkspace } from "@/lib/documents/workspace";
import { useZonedFormat } from "@/lib/time/zoned-format";
import { cn } from "@/utils/tailwind";
import { BulkUploadDropzone } from "./BulkUploadDropzone";
import { ThreadCard } from "./ThreadCard";

type Filter = "all" | "your-turn" | "waiting" | "done" | "shared";

const FILTERS: Filter[] = ["all", "your-turn", "waiting", "done", "shared"];

function filterLabel(filter: Filter, expert: boolean): string {
  switch (filter) {
    case "all":
      return "All";
    case "your-turn":
      return expert ? "Needs you" : "Your turn";
    case "waiting":
      return expert ? "Waiting for learner" : "Waiting for expert";
    case "done":
      return "Done";
    case "shared":
      return expert ? "Shared by you" : "Shared with you";
  }
}

function matches(
  thread: ThreadView,
  filter: Filter,
  role: "learner" | "expert",
): boolean {
  if (filter === "all") return true;
  if (filter === "shared") return thread.kind === "shared";
  if (thread.kind === "shared") return false;
  const done = thread.status === "APPROVED" || thread.status === "NOT_ACCEPTED";
  if (filter === "done") return done;
  const mine = threadNeedsViewer(thread, role);
  return filter === "your-turn" ? mine : !done && !mine;
}

async function fetchWorkspace(
  appointmentId: string,
): Promise<DocumentWorkspace> {
  let res: Response;
  try {
    res = await fetch(
      `/api/appointments/${encodeURIComponent(appointmentId)}/documents`,
    );
  } catch {
    throw new FileActionError(friendlyFileError("NETWORK"));
  }
  if (!res.ok) throw new FileActionError(await friendlyErrorFromResponse(res));
  return res.json();
}

/** The per-booking Documents workspace for either side; actions come from the server. */
export function DocumentsWorkspace({
  appointmentId,
  backHref,
}: Readonly<{ appointmentId: string; backHref: string }>) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const format = useZonedFormat();
  const day = (iso: string) => format(iso, "d MMM yyyy");

  const { data, error, isLoading, refetch } = useQuery({
    queryKey: documentKeys.workspace(appointmentId),
    queryFn: () => fetchWorkspace(appointmentId),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const rawFilter = params.get("filter");
  const filter: Filter = FILTERS.find((f) => f === rawFilter) ?? "all";
  const focusThread = params.get("thread");

  useEffect(() => {
    if (!focusThread || !data) return;
    document
      .getElementById(`thread-${focusThread}`)
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [focusThread, data]);

  const setFilter = (next: Filter) => {
    const search = new URLSearchParams(params.toString());
    if (next === "all") search.delete("filter");
    else search.set("filter", next);
    const qs = search.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const refresh = () =>
    void invalidateDocumentReads(queryClient, appointmentId);

  const threads = useMemo(
    () =>
      data
        ? data.threads.filter((t) =>
            matches(t, filter, data.booking.viewerRole),
          )
        : [],
    [data, filter],
  );

  if (isLoading && !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  if (error || !data) {
    const copy =
      error instanceof FileActionError
        ? { title: error.title, description: error.message, code: error.code }
        : { ...friendlyFileError("SERVER_ERROR"), code: "SERVER_ERROR" };
    const retryable =
      copy.code === "SERVER_ERROR" ||
      copy.code === "NETWORK" ||
      copy.code === "STORAGE_UNAVAILABLE" ||
      copy.code === "RATE_LIMITED";
    return (
      <EmptyState
        icon={FileText}
        title={copy.title}
        description={copy.description}
        action={
          retryable ? (
            <Button variant="outline" onClick={() => void refetch()}>
              Retry
            </Button>
          ) : (
            <Button asChild variant="outline">
              <Link href={backHref}>Back to the session</Link>
            </Button>
          )
        }
      />
    );
  }

  const { booking, limits } = data;
  const expert = booking.viewerRole === "expert";
  const counterpart = expert ? booking.learnerName : booking.expertName;
  const notices = booking.readOnlyReason
    ? [
        readOnlyNotice({
          reason: booking.readOnlyReason,
          terminalAt: booking.terminalAt,
          closesAt: booking.uploadWindow.closesAt,
          keptUntil: booking.keptUntil,
          day,
        }),
      ]
    : windowNotice({
        closesAt: booking.uploadWindow.closesAt,
        keptUntil: booking.keptUntil,
        day,
      });

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to session
        </Link>
        <h1 className="text-xl font-semibold text-foreground">
          Documents · {booking.title} with {counterpart}
        </h1>
        <div
          className={cn(
            "space-y-0.5 rounded-lg px-3 py-2 text-xs",
            booking.readOnlyReason
              ? "flex items-start gap-2 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
              : "bg-muted/40 text-muted-foreground",
          )}
          role="status"
        >
          {booking.readOnlyReason && (
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          )}
          <div>
            {notices.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </div>
      </div>

      {!booking.readOnlyReason && (
        <BulkUploadDropzone
          appointmentId={appointmentId}
          used={limits.documents.used}
          max={limits.documents.max}
          label={
            expert
              ? `Share files with ${booking.learnerName}`
              : "Drop files here or browse"
          }
          onUploaded={refresh}
        />
      )}

      <div
        role="group"
        aria-label="Filter documents"
        className="flex flex-wrap gap-1.5"
      >
        {FILTERS.map((f) => (
          <Button
            key={f}
            type="button"
            size="sm"
            variant={filter === f ? "secondary" : "ghost"}
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className="h-8"
          >
            {filterLabel(f, expert)}
          </Button>
        ))}
      </div>

      {data.threads.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={expert ? "Nothing to review" : "Nothing shared yet"}
          description={
            expert
              ? `Files ${booking.learnerName} shares appear here. You can share a file with them too.`
              : `Share files with ${booking.expertName} for review.`
          }
        />
      ) : threads.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No documents match this filter.
        </p>
      ) : (
        <div className="space-y-3">
          {threads.map((thread) => (
            <ThreadCard
              key={thread.rootId}
              appointmentId={appointmentId}
              thread={thread}
              names={{
                viewerRole: booking.viewerRole,
                learnerName: booking.learnerName,
                expertName: booking.expertName,
                organizationName: booking.organizationName,
              }}
              day={day}
              focused={thread.rootId === focusThread}
              onChanged={refresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}
