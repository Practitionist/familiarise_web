"use client";

import { useState, useEffect, useCallback } from "react";
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
import { RecordingCard, RecordingData } from "./RecordingCard";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface RecordingsListProps {
  consultantId: string;
  type?: "webinar" | "class" | null;
}

export function RecordingsList({ consultantId, type }: RecordingsListProps) {
  const { toast } = useToast();
  const [recordings, setRecordings] = useState<RecordingData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  // Search + pagination state
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 12;

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Reset page when type filter changes
  useEffect(() => {
    setPage(1);
  }, [type]);

  const fetchRecordings = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const params = new URLSearchParams();
      if (type) {
        params.set("type", type);
      }
      params.set("page", page.toString());
      params.set("limit", limit.toString());
      if (debouncedSearch) {
        params.set("search", debouncedSearch);
      }

      const response = await fetch(
        `/api/consultants/${consultantId}/recordings?${params.toString()}`,
      );

      if (!response.ok) {
        throw new Error("Failed to fetch recordings");
      }

      const data = await response.json();
      setRecordings(data.recordings);
      setTotalPages(data.totalPages ?? 1);
      setTotal(data.total ?? 0);
    } catch (err) {
      console.error("Error fetching recordings:", err);
      setError(
        err instanceof Error ? err.message : "Failed to load recordings",
      );
    } finally {
      setIsLoading(false);
    }
  }, [consultantId, type, page, debouncedSearch]);

  useEffect(() => {
    fetchRecordings();
  }, [fetchRecordings]);

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      const response = await fetch("/api/stream/recordings/sync", {
        method: "POST",
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to sync recordings");
      }

      if (data.synced > 0) {
        toast({
          title: "Synced",
          description: `${data.synced} recording(s) synced from Stream.`,
        });
        await fetchRecordings();
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

  const handleTransfer = async (recordingId: string) => {
    const response = await fetch(
      `/api/stream/recordings/${recordingId}/transfer`,
      {
        method: "POST",
      },
    );

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Transfer failed");
    }

    // Refresh recordings list after successful transfer
    await fetchRecordings();

    toast({
      title: "Success",
      description: "Recording transferred to permanent storage.",
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <AlertCircle className="w-12 h-12 text-muted-foreground mb-4" />
        <p className="text-lg font-medium">Failed to load recordings</p>
        <p className="text-sm text-muted-foreground mt-1">{error}</p>
        <button
          onClick={fetchRecordings}
          className="mt-4 text-sm text-primary hover:underline"
        >
          Try again
        </button>
      </div>
    );
  }

  if (recordings.length === 0 && !debouncedSearch) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Video className="w-12 h-12 text-muted-foreground mb-4" />
        <p className="text-lg font-medium">No recordings yet</p>
        <p className="text-sm text-muted-foreground mt-1">
          {type === "webinar"
            ? "Webinar recordings will appear here after you record a session."
            : type === "class"
              ? "Class recordings will appear here after you record a session."
              : "Your recorded sessions will appear here."}
        </p>
        <p className="text-sm text-muted-foreground mt-2 max-w-md">
          Recordings are created automatically when you enable recording during
          a webinar or class session. Use the button below to check for new
          recordings.
        </p>
        <Button
          onClick={handleSync}
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

  return (
    <div className="space-y-4">
      {/* Search bar + Sync button */}
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

      {/* Results count */}
      {total > 0 && (
        <p className="text-sm text-muted-foreground">
          Showing {(page - 1) * limit + 1}-{Math.min(page * limit, total)} of{" "}
          {total} recordings
        </p>
      )}

      {/* Empty search results */}
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

      {/* Recordings grid */}
      {recordings.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {recordings.map((recording) => (
            <RecordingCard
              key={recording.id}
              recording={recording}
              onTransfer={handleTransfer}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-6 pt-4 border-t">
          <p className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
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
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default RecordingsList;
