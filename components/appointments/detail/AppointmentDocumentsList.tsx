"use client";

import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ExternalLink, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { documentReviewStatusBadge } from "@/lib/labels/session-labels";

interface AppointmentDocument {
  id: string;
  fileName: string;
  originalName?: string | null;
  fileUrl: string;
  description?: string | null;
  reviewStatus?: string | null;
  uploadedByRole?: string | null;
  createdAt?: string | null;
}

const UPLOADER_LABEL: Record<
  "consultee" | "consultant",
  Record<string, string>
> = {
  consultant: { CONSULTEE: "From the client", CONSULTANT: "Your response" },
  consultee: { CONSULTEE: "Your upload", CONSULTANT: "From your expert" },
};

/** Read-only document list for the detail page: the consultant's view, and
 *  the consultee's once a booking is completed (#1527 — uploads close, the
 *  files stay readable). */
export function AppointmentDocumentsList({
  appointmentId,
  viewer = "consultant",
}: {
  appointmentId: string;
  viewer?: "consultee" | "consultant";
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["appointment-documents", appointmentId] as const,
    queryFn: async (): Promise<AppointmentDocument[]> => {
      const res = await fetch(`/api/appointments/${appointmentId}/documents`);
      if (!res.ok) throw new Error("Failed to fetch documents");
      const { data } = await res.json();
      return data ?? [];
    },
  });

  if (isLoading) return <Skeleton className="h-16 w-full rounded-lg" />;
  if (isError) {
    return (
      <p className="text-xs text-muted-foreground">
        Documents couldn&apos;t be loaded.
      </p>
    );
  }
  if (!data || data.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No documents have been shared for this booking.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {data.length} {data.length === 1 ? "file" : "files"} shared
      </p>
      {data.map((doc) => (
        <div
          key={doc.id}
          className="flex items-center justify-between gap-2 rounded-lg bg-muted border border-border px-3 py-2"
        >
          <div className="flex items-center gap-2 min-w-0">
            <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground truncate">
                {doc.originalName ?? doc.fileName}
              </p>
              <p className="text-[11px] text-muted-foreground truncate">
                {doc.uploadedByRole &&
                  `${UPLOADER_LABEL[viewer][doc.uploadedByRole] ?? ""} · `}
                {doc.description ??
                  (doc.createdAt
                    ? format(new Date(doc.createdAt), "d MMM yyyy")
                    : "")}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {doc.reviewStatus && (
              <StatusBadge
                {...documentReviewStatusBadge(doc.reviewStatus)}
                size="sm"
              />
            )}
            <Button variant="outline" size="sm" asChild>
              <a href={doc.fileUrl} target="_blank" rel="noopener noreferrer">
                Open
                <ExternalLink className="h-3 w-3 ml-1" />
              </a>
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
