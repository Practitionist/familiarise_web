"use client";

import { useState, useEffect } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  Loader2,
  Video,
  AlertCircle,
  RefreshCw,
  Search,
  X,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { RecordingCard, type ExtendedRecordingData } from "./RecordingCard";
import { RecordingPlayerModal } from "@/components/recordings/RecordingPlayerModal";
import { RecordingManageSheet } from "@/components/recordings/RecordingManageSheet";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/dashboard/DataCard";
import { createConsultantQueries } from "@/lib/dashboard-queries";

export type ConsultantRecordingFilterType =
  "webinar" | "class" | "consultation" | "subscription" | "trial";

const EMPTY_RECORDING_MESSAGES: Record<ConsultantRecordingFilterType, string> =
  {
    webinar: "Webinar recordings will appear here after you record a session.",
    class: "Class recordings will appear here after you record a session.",
    consultation:
      "Consultation recordings will appear here after you record a session.",
    subscription:
      "Subscription recordings will appear here after you record a session.",
    trial: "Your recorded sessions will appear here.",
  };

function getEmptyRecordingMessage(
  type?: ConsultantRecordingFilterType | null,
): string {
  if (!type) return "Your recorded sessions will appear here.";
  return EMPTY_RECORDING_MESSAGES[type];
}

function RecordingsSkeletonGrid() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {[1, 2, 3].map((i) => (
        <div key={i} className="space-y-3">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="aspect-video w-full rounded-lg" />
          <Skeleton className="h-9 w-full rounded-lg" />
        </div>
      ))}
    </div>
  );
}

interface NoRecordingsEmptyStateProps {
  readonly type?: ConsultantRecordingFilterType | null;
  readonly isSyncing: boolean;
  readonly onSync: () => void;
}

function NoRecordingsEmptyState({
  type,
  isSyncing,
  onSync,
}: Readonly<NoRecordingsEmptyStateProps>) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Video className="w-12 h-12 text-muted-foreground mb-4" />
      <p className="text-lg font-medium">No recordings yet</p>
      <p className="text-sm text-muted-foreground mt-1">
        {getEmptyRecordingMessage(type)}
      </p>
      <p className="text-sm text-muted-foreground mt-2 max-w-md">
        Recordings are created automatically when you enable recording during a
        session. Use the button below to check for new recordings.
      </p>
      <Button
        onClick={onSync}
        disabled={isSyncing}
        variant="outline"
        size="sm"
        className="mt-4"
      >
        {isSyncing ? (
          <Loader2 className="w-4 h-4 animate-spin mr-2" />
        ) : (
          <RefreshCw className="w-4 h-4 mr-2" />
        )}
        Sync from Stream
      </Button>
    </div>
  );
}

interface RecordingsPaginationProps {
  readonly page: number;
  readonly totalPages: number;
  readonly onPageChange: (nextPage: number) => void;
}

function RecordingsPagination({
  page,
  totalPages,
  onPageChange,
}: Readonly<RecordingsPaginationProps>) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between mt-6 pt-4 border-t">
      <p className="text-sm text-muted-foreground">
        Page {page} of {totalPages}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page === 1}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-sm min-w-[80px] text-center">
          {page} / {totalPages}
        </span>
        <Button
          variant="outline"
          size="icon"
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page === totalPages}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

interface RecordingsListProps {
  readonly consultantId: string;
  readonly type?: ConsultantRecordingFilterType | null;
}

export function RecordingsList({
  consultantId,
  type,
}: Readonly<RecordingsListProps>) {
  const { toast } = useToast();
  const [isSyncing, setIsSyncing] = useState(false);
  const [activePlayerRecordingId, setActivePlayerRecordingId] = useState<
    string | null
  >(null);
  const [activeManageRecordingId, setActiveManageRecordingId] = useState<
    string | null
  >(null);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const limit = 12;

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [type]);

  const { data, isPending, isError, error, refetch } = useQuery({
    ...createConsultantQueries(consultantId).recordings({
      type: (type as "webinar" | "class" | null) ?? null,
      page,
      limit,
      search: debouncedSearch,
    }),
    placeholderData: keepPreviousData,
  });

  const recordings = (data?.recordings ?? []) as ExtendedRecordingData[];
  const totalPages = data?.totalPages ?? 1;
  const total = data?.total ?? 0;

  const activePlayerRecording =
    recordings.find((r) => r.id === activePlayerRecordingId) ?? null;
  const activeManageRecording =
    recordings.find((r) => r.id === activeManageRecordingId) ?? null;

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      const response = await fetch("/api/stream/recordings/sync", {
        method: "POST",
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Failed to sync recordings");
      }

      if (payload.synced > 0) {
        toast({
          title: "Synced",
          description: `${payload.synced} recording(s) synced from Stream.`,
        });
        await refetch();
      } else {
        toast({
          title: "Up to date",
          description: "No new recordings found.",
        });
      }
    } catch (err) {
      console.error("Error syncing recordings:", err);
      toast({
        title: "Error",
        description:
          err instanceof Error ? err.message : "Failed to sync recordings",
        variant: "destructive",
      });
    } finally {
      setIsSyncing(false);
    }
  };

  if (isPending) {
    return <RecordingsSkeletonGrid />;
  }

  if (isError) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Failed to load recordings"
        description={
          error instanceof Error ? error.message : "Please try again."
        }
        action={
          <Button variant="outline" onClick={() => refetch()}>
            Try again
          </Button>
        }
      />
    );
  }

  if (recordings.length === 0 && !debouncedSearch) {
    return (
      <NoRecordingsEmptyState
        type={type}
        isSyncing={isSyncing}
        onSync={handleSync}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search recordings by title..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 pr-9"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Button
          onClick={handleSync}
          disabled={isSyncing}
          variant="outline"
          size="sm"
          className="shrink-0"
        >
          {isSyncing ? (
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
          ) : (
            <RefreshCw className="w-4 h-4 mr-2" />
          )}
          Sync from Stream
        </Button>
      </div>

      {total > 0 && (
        <p className="text-sm text-muted-foreground">
          Showing {(page - 1) * limit + 1}-{Math.min(page * limit, total)} of{" "}
          {total} recordings
        </p>
      )}

      {recordings.length === 0 && debouncedSearch && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Search className="w-12 h-12 text-muted-foreground mb-4" />
          <p className="text-lg font-medium">No recordings found</p>
          <p className="text-sm text-muted-foreground mt-1">
            No recordings match &quot;{debouncedSearch}&quot;
          </p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => setSearch("")}
          >
            Clear Search
          </Button>
        </div>
      )}

      {recordings.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {recordings.map((recording) => (
            <RecordingCard
              key={recording.id}
              recording={recording}
              onWatch={(rec) => setActivePlayerRecordingId(rec.id)}
              onManage={(rec) => setActiveManageRecordingId(rec.id)}
            />
          ))}
        </div>
      )}

      <RecordingsPagination
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
      />

      <RecordingPlayerModal
        open={Boolean(activePlayerRecording)}
        onOpenChange={(open) => {
          if (!open) setActivePlayerRecordingId(null);
        }}
        recording={
          activePlayerRecording
            ? {
                id: activePlayerRecording.id,
                title: activePlayerRecording.title,
                recordedAt: activePlayerRecording.recordedAt,
                durationInMinutes: activePlayerRecording.durationInMinutes,
                resolution: activePlayerRecording.resolution,
                playbackUrl: activePlayerRecording.playbackUrl,
                storageType: activePlayerRecording.storageType,
                planTitle: activePlayerRecording.planTitle,
                previewTranscript: activePlayerRecording.previewTranscript,
              }
            : null
        }
      />

      <RecordingManageSheet
        open={Boolean(activeManageRecording)}
        onOpenChange={(open) => {
          if (!open) setActiveManageRecordingId(null);
        }}
        recording={activeManageRecording}
        onUpdated={() => {
          void refetch();
        }}
      />
    </div>
  );
}
