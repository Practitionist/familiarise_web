"use client";

import { useState, useEffect } from "react";
import { Loader2, Video, AlertCircle } from "lucide-react";
import { RecordingCard, RecordingData } from "./RecordingCard";
import { useToast } from "@/hooks/use-toast";

interface RecordingsListProps {
  consultantId: string;
  type?: "webinar" | "class" | null;
}

export function RecordingsList({ consultantId, type }: RecordingsListProps) {
  const { toast } = useToast();
  const [recordings, setRecordings] = useState<RecordingData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRecordings = async () => {
    try {
      setIsLoading(true);
      setError(null);

      const params = new URLSearchParams();
      if (type) {
        params.set("type", type);
      }

      const response = await fetch(
        `/api/consultants/${consultantId}/recordings?${params.toString()}`
      );

      if (!response.ok) {
        throw new Error("Failed to fetch recordings");
      }

      const data = await response.json();
      setRecordings(data.recordings);
    } catch (err) {
      console.error("Error fetching recordings:", err);
      setError(err instanceof Error ? err.message : "Failed to load recordings");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchRecordings();
  }, [consultantId, type]);

  const handleTransfer = async (recordingId: string) => {
    const response = await fetch(`/api/recordings/${recordingId}/transfer`, {
      method: "POST",
    });

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

  if (recordings.length === 0) {
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
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {recordings.map((recording) => (
        <RecordingCard
          key={recording.id}
          recording={recording}
          onTransfer={handleTransfer}
        />
      ))}
    </div>
  );
}

export default RecordingsList;
