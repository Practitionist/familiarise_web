"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Video } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/dashboard/EmptyState";
import {
  FileActionError,
  friendlyErrorFromResponse,
  friendlyFileError,
} from "@/lib/documents/file-errors";
import { recordingKeys } from "@/lib/documents/query-keys";
import {
  keptUntilText,
  partLabel,
  whoCanWatchText,
} from "@/lib/stream/recording-copy";
import type {
  RecordingBookingView,
  RecordingSlot,
  SlotPart,
} from "@/lib/stream/recording-slots";
import {
  timelineOf,
  timelineRows,
  truncateUpcoming,
} from "@/lib/stream/recording-timeline";
import { useZonedFormat } from "@/lib/time/zoned-format";
import { RecordingManageSheet } from "./RecordingManageSheet";
import { RecordingPlayerModal } from "./RecordingPlayerModal";
import { RecordingTimelineCard } from "./RecordingTimeline";

async function fetchSlots(
  appointmentId: string,
): Promise<RecordingBookingView> {
  let res: Response;
  try {
    res = await fetch(
      `/api/appointments/${encodeURIComponent(appointmentId)}/recordings`,
    );
  } catch {
    throw new FileActionError(friendlyFileError("NETWORK"));
  }
  if (!res.ok) throw new FileActionError(await friendlyErrorFromResponse(res));
  return res.json();
}

/** The per-booking Recording details list: the viewer's sessions, parts, catch-up and the player. */
export function RecordingSessions({
  appointmentId,
  backHref,
}: Readonly<{ appointmentId: string; backHref: string }>) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const format = useZonedFormat();
  const day = (iso: string) => format(iso, "d MMM yyyy");
  const [managing, setManaging] = useState<SlotPart | null>(null);

  const { data, error, isLoading, refetch } = useQuery({
    queryKey: recordingKeys.appointment(appointmentId),
    queryFn: () => fetchSlots(appointmentId),
    staleTime: 30_000,
  });

  const selectedId = params.get("r");
  const focusSlot = params.get("slot");

  const flatParts = useMemo(
    () =>
      (data?.slots ?? []).flatMap((slot) =>
        slot.parts.map((part) => ({ slot, part })),
      ),
    [data],
  );
  const selected = flatParts.find((p) => p.part.recordingId === selectedId);
  const nextInSlot = selected
    ? selected.slot.parts[
        selected.slot.parts.findIndex(
          (p) => p.recordingId === selected.part.recordingId,
        ) + 1
      ]
    : undefined;

  useEffect(() => {
    if (!focusSlot || !data) return;
    document
      .getElementById(`slot-${focusSlot}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusSlot, data]);

  const select = (slot: RecordingSlot | null, part: SlotPart | null) => {
    const search = new URLSearchParams(params.toString());
    if (slot && part) {
      search.set("slot", String(slot.ordinal));
      search.set("r", part.recordingId);
    } else {
      search.delete("r");
    }
    const qs = search.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  if (isLoading && !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }
  if (error || !data) {
    const copy =
      error instanceof FileActionError
        ? { title: error.title, description: error.message }
        : friendlyFileError("SERVER_ERROR");
    return (
      <EmptyState
        icon={Video}
        title={copy.title}
        description={copy.description}
        action={
          <Button variant="outline" onClick={() => void refetch()}>
            Retry
          </Button>
        }
      />
    );
  }

  const host = data.viewerRole === "host";
  const refresh = () =>
    void queryClient.invalidateQueries({
      queryKey: recordingKeys.appointment(appointmentId),
    });

  const allRows = timelineRows(data);
  const { rows, moreUpcoming } = truncateUpcoming(allRows);
  const timeline = { ...timelineOf(data, allRows), moreUpcoming };
  const partOf = (id: string) =>
    flatParts.find((p) => p.part.recordingId === id);
  const manageButton = (part: SlotPart) =>
    host && part.listing ? (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7"
        aria-label={`Manage ${part.title}`}
        onClick={() => setManaging(part)}
      >
        Manage
      </Button>
    ) : null;

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to session
        </Link>
        <h1 className="text-xl font-semibold text-foreground">Recordings</h1>
        <p className="text-xs text-muted-foreground">
          {whoCanWatchText(data.audience)}.
        </p>
      </div>

      {data.slots.length === 0 ? (
        <EmptyState
          icon={Video}
          title="No sessions"
          description="This booking has no sessions to show."
        />
      ) : (
        <RecordingTimelineCard
          title={data.title}
          expertName={data.expertName}
          kind={data.kind}
          timeline={timeline}
          bookingHref={null}
          moreHref={backHref}
          rows={rows}
          anchorRows
          manage={(row) =>
            row.parts.length === 1 && row.removedParts.length === 0
              ? (() => {
                  const hit = partOf(row.parts[0]!.id);
                  return hit ? manageButton(hit.part) : null;
                })()
              : null
          }
          managePart={(part) => {
            const hit = partOf(part.id);
            return hit ? manageButton(hit.part) : null;
          }}
          onPlay={(part) => {
            const hit = partOf(part.id);
            if (hit) select(hit.slot, hit.part);
          }}
        />
      )}

      <RecordingPlayerModal
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) select(null, null);
        }}
        recording={
          selected
            ? {
                id: selected.part.recordingId,
                title: selected.part.title,
                recordedAt: selected.part.recordedAt,
                durationInMinutes: selected.part.durationInMinutes,
                planTitle: `Session ${selected.slot.ordinal}`,
              }
            : null
        }
        partLabel={selected ? partLabel(selected.part) : null}
        onNextPart={
          selected && nextInSlot
            ? () => select(selected.slot, nextInSlot)
            : null
        }
      />

      <RecordingManageSheet
        open={Boolean(managing)}
        onOpenChange={(open) => !open && setManaging(null)}
        recording={
          managing?.listing
            ? {
                id: managing.recordingId,
                title: managing.title,
                listingStatus:
                  managing.listing.status === "PUBLISHED"
                    ? "PUBLISHED"
                    : managing.listing.status === "UNPUBLISHED"
                      ? "UNPUBLISHED"
                      : "DRAFT",
                hasBuyers: managing.listing.hasBuyers,
                whoCanWatch: whoCanWatchText(data.audience),
                keptUntil: keptUntilText(managing.keptUntil, day),
                sharedAcrossRuns: data.sharedAcrossRuns,
              }
            : null
        }
        onUpdated={refresh}
      />
    </div>
  );
}
