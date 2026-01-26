"use client";

import { useState, useEffect } from "react";
import { Loader2, Video, AlertCircle, RefreshCw } from "lucide-react";
import {
  ConsulteeRecordingCard,
  ConsulteeRecordingData,
} from "./ConsulteeRecordingCard";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";

interface ConsulteeRecordingsListProps {
  consulteeId: string;
  type?: "webinar" | "class" | null;
}

export function ConsulteeRecordingsList({
  consulteeId,
  type,
}: ConsulteeRecordingsListProps) {
  const { toast } = useToast();
  const [recordings, setRecordings] = useState<ConsulteeRecordingData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  const fetchRecordings = async () => {
    try {
      setIsLoading(true);
      setError(null);

      const params = new URLSearchParams();
      if (type) {
        params.set("type", type);
      }

      const response = await fetch(
        `/api/consultees/${consulteeId}/recordings?${params.toString()}`,
      );

      if (!response.ok) {
        throw new Error("Failed to fetch recordings");
      }

      const data = await response.json();
      setRecordings(data.recordings);
    } catch (err) {
      console.error("Error fetching recordings:", err);
      setError(
        err instanceof Error ? err.message : "Failed to load recordings",
      );
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchRecordings();
  }, [consulteeId, type]);

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

  if (recordings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Video className="w-12 h-12 text-muted-foreground mb-4" />
        <p className="text-lg font-medium">No recordings available</p>
        <p className="text-sm text-muted-foreground mt-1 max-w-md">
          {type === "webinar"
            ? "Recordings from your enrolled webinars will appear here."
            : type === "class"
              ? "Recordings from your enrolled classes will appear here."
              : "Recordings from your enrolled webinars and classes will appear here after the consultant records a session."}
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
      <div className="flex justify-end">
        <Button
          onClick={handleSync}
          disabled={isSyncing}
          variant="outline"
          size="sm"
        >
          {isSyncing ? (
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
          ) : (
            <RefreshCw className="w-4 h-4 mr-2" />
          )}
          Sync from Stream
        </Button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {recordings.map((recording) => (
          <ConsulteeRecordingCard key={recording.id} recording={recording} />
        ))}
      </div>
    </div>
  );
}

export default ConsulteeRecordingsList;
