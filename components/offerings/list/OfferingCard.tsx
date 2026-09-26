"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Archive,
  Copy,
  Gift,
  Link2,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
  Undo2,
  Users,
  Video,
} from "lucide-react";

import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import type { OfferingStat } from "@/lib/offerings/stats";
import { formatCurrencyAmount } from "@/utils/formatting";

import {
  OFFERING_TYPE_LABEL,
  publicOfferingHref,
  type OfferingRow,
} from "./offering-rows";

const COLLABORATOR_ROLE_LABEL: Record<string, string> = {
  HOST: "Host",
  CO_HOST: "Co-host",
  MODERATOR: "Moderator",
  CO_INSTRUCTOR: "Co-instructor",
  TEACHING_ASSISTANT: "Teaching assistant",
};

const ORG_GOVERNED_HINT = "Managed by your organisation";

export interface OfferingCardProps {
  row: OfferingRow;
  /** Absent for collaborated rows and while the stats read is in flight. */
  stat?: OfferingStat;
  editHref: string | null;
  duplicateHref: string | null;
  trials?: { href: string; pending: number };
  join?: { canJoin: boolean; isJoining: boolean; onJoin: () => void };
  onArchiveToggle?: () => Promise<unknown>;
  onDelete?: () => Promise<unknown>;
}

function formatStart(date: Date | null): string {
  if (!date) return "Not scheduled yet";
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Throws the server's sentence so ConfirmDialog shows it inline. */
async function runOrExplain(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : "That didn't work. Try again.",
    );
  }
}

export function OfferingCard({
  row,
  stat,
  editHref,
  duplicateHref,
  trials,
  join,
  onArchiveToggle,
  onDelete,
}: Readonly<OfferingCardProps>) {
  const { toast } = useToast();
  const [confirm, setConfirm] = useState<"archive" | "delete" | null>(null);
  const [restoring, setRestoring] = useState(false);

  const owned = !row.isCollaborated;
  const shareHref =
    row.planId && !row.isDraft && !row.isArchived
      ? publicOfferingHref(row.type, row.planId)
      : null;
  const orgGoverned = stat?.orgGoverned ?? false;
  // #1527-6 — Delete only on a plan with no bookings and no payments.
  const canDelete = !!onDelete && stat?.canDelete === true;
  const isDevJoin = process.env.NEXT_PUBLIC_ENABLE_DEV_TOOLS === "true";

  const copyShareLink = async () => {
    if (!shareHref) return;
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}${shareHref}`,
      );
      toast({ title: "Link copied", description: row.title });
    } catch {
      toast({
        title: "Couldn't copy the link",
        description: "Open the public page and copy it from the address bar.",
        variant: "destructive",
      });
    }
  };

  const restore = async () => {
    if (!onArchiveToggle) return;
    setRestoring(true);
    try {
      await onArchiveToggle();
    } catch (error) {
      toast({
        title: "Couldn't restore it",
        description:
          error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setRestoring(false);
    }
  };

  const archiveItem = onArchiveToggle && (
    <DropdownMenuItem
      disabled={orgGoverned || restoring}
      onSelect={() => {
        if (row.isArchived) void restore();
        else setConfirm("archive");
      }}
    >
      {row.isArchived ? (
        <Undo2 className="mr-2 h-4 w-4" />
      ) : (
        <Archive className="mr-2 h-4 w-4" />
      )}
      {row.isArchived ? "Restore" : "Archive"}
    </DropdownMenuItem>
  );

  return (
    <article className="flex h-full flex-col rounded-xl border border-border bg-card p-4 sm:p-5">
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {OFFERING_TYPE_LABEL[row.type]}
            </span>
            <StatusBadge
              label={row.status.label}
              tone={row.status.tone}
              size="sm"
            />
            {row.batch && (
              <StatusBadge
                label={`Batch ${row.batch.index} of ${row.batch.total}`}
                tone="neutral"
                size="sm"
              />
            )}
            {row.isCollaborated && row.collaboratorRole && (
              <StatusBadge
                label={
                  COLLABORATOR_ROLE_LABEL[row.collaboratorRole] ??
                  "Collaborator"
                }
                tone="info"
                size="sm"
              />
            )}
          </div>
          <h3 className="text-[15px] font-semibold leading-snug text-foreground">
            {row.title}
          </h3>
        </div>

        {owned && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                aria-label={`More actions for ${row.title}`}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {duplicateHref && (
                <DropdownMenuItem asChild>
                  <Link href={duplicateHref}>
                    <Copy className="mr-2 h-4 w-4" />
                    Duplicate
                  </Link>
                </DropdownMenuItem>
              )}
              {archiveItem &&
                (orgGoverned ? (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div>{archiveItem}</div>
                      </TooltipTrigger>
                      <TooltipContent>{ORG_GOVERNED_HINT}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  archiveItem
                ))}
              {canDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => setConfirm("delete")}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>

      <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
        {row.description || "No description yet."}
      </p>

      <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <div>
          <dt className="sr-only">Price</dt>
          <dd className="font-medium text-foreground tabular-nums">
            {row.priceText}
          </dd>
        </div>
        <div>
          <dt className="sr-only">Duration</dt>
          <dd>{row.durationText}</dd>
        </div>
        {(row.type === "webinar" || row.type === "class") && (
          <div>
            <dt className="sr-only">First session</dt>
            <dd>{formatStart(row.startsAt)}</dd>
          </div>
        )}
        {row.seats && (
          <div className="flex items-center gap-1">
            <dt className="sr-only">Seats</dt>
            <Users className="h-3.5 w-3.5" aria-hidden />
            <dd className="tabular-nums">
              {row.seats.taken}/{row.seats.capacity}
            </dd>
          </div>
        )}
      </dl>

      {stat && (
        <p className="mt-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground tabular-nums">
            {stat.bookings}
          </span>{" "}
          {stat.bookings === 1 ? "booking" : "bookings"} ·{" "}
          <span className="font-medium text-foreground tabular-nums">
            {formatCurrencyAmount(stat.earningsPaise, "INR")}
          </span>{" "}
          earned
        </p>
      )}

      {trials && row.trialEnabled && (
        <Link
          href={trials.href}
          className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-foreground underline-offset-4 hover:underline"
        >
          <Gift className="h-3.5 w-3.5" aria-hidden />
          {trials.pending > 0
            ? `${trials.pending} trial ${trials.pending === 1 ? "request" : "requests"}`
            : "Trial requests"}
        </Link>
      )}

      <footer className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        {join && (join.canJoin || isDevJoin) && (
          <Button size="sm" onClick={join.onJoin} disabled={join.isJoining}>
            {join.isJoining ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Video className="mr-1.5 h-3.5 w-3.5" />
            )}
            {join.canJoin ? "Join" : "Join (Dev)"}
          </Button>
        )}
        {owned && editHref && (
          <Button asChild size="sm" variant="outline">
            <Link href={editHref}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              Edit
            </Link>
          </Button>
        )}
        {shareHref && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void copyShareLink()}
          >
            <Link2 className="mr-1.5 h-3.5 w-3.5" />
            Share link
          </Button>
        )}
      </footer>

      {onArchiveToggle && (
        <ConfirmDialog
          open={confirm === "archive"}
          onOpenChange={(open) => setConfirm(open ? "archive" : null)}
          title={`Archive “${row.title}”?`}
          description="It stops taking new bookings and leaves the marketplace. Existing bookings are unaffected, and you can restore it any time."
          confirmLabel="Archive"
          onConfirm={() => runOrExplain(onArchiveToggle)}
        />
      )}
      {canDelete && onDelete && (
        <ConfirmDialog
          open={confirm === "delete"}
          onOpenChange={(open) => setConfirm(open ? "delete" : null)}
          title={`Delete “${row.title}”?`}
          description="Nobody has booked or paid for it, so it can be removed for good. This can't be undone."
          confirmLabel="Delete"
          tone="destructive"
          onConfirm={() => runOrExplain(onDelete)}
        />
      )}
    </article>
  );
}
