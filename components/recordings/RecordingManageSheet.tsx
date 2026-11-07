"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Loader2, Save, Trash2 } from "lucide-react";
import { z } from "zod";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  friendlyFileError,
  resolveFileErrorCode,
} from "@/lib/documents/file-errors";

export interface ManagedRecordingData {
  id: string;
  title: string;
  listingStatus: "DRAFT" | "PUBLISHED" | "UNPUBLISHED";
  hasBuyers: boolean;
  /** "Only you and the attendee", "Attendees of this run", … */
  whoCanWatch: string;
  /** "Kept until 9 Jan 2027", "Kept while the subscription is active", … */
  keptUntil: string | null;
  /** Webinars only: whether other runs' attendees may catch up from it. */
  sharedAcrossRuns: boolean | null;
}

export interface RecordingManageSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly recording: ManagedRecordingData | null;
  readonly onUpdated?: () => void | Promise<void>;
}

export function canDeleteRecording(
  recording: Pick<ManagedRecordingData, "hasBuyers">,
): boolean {
  return !recording.hasBuyers;
}

const ErrorBodySchema = z.object({ code: z.string().optional() });

async function failureCopy(res: Response): Promise<string> {
  const parsed = ErrorBodySchema.safeParse(await res.json().catch(() => null));
  const code = resolveFileErrorCode(
    res.status,
    parsed.success ? parsed.data.code : undefined,
  );
  if (res.status === 409) {
    return "This recording has buyers or changed while you were editing. Refresh and try again.";
  }
  return friendlyFileError(code).description;
}

/**
 * The host's manage sheet: rename, delete (attendees are told), who can
 * watch and how long it is kept. Replays are not sold; a listing made
 * before that can still be withdrawn.
 */
export function RecordingManageSheet({
  open,
  onOpenChange,
  recording,
  onUpdated,
}: Readonly<RecordingManageSheetProps>) {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState<
    "rename" | "delete" | "unpublish" | null
  >(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    setConfirmingDelete(false);
    if (recording && open) setTitle(recording.title);
  }, [recording, open]);

  if (!recording) return null;
  const canDelete = canDeleteRecording(recording);
  const base = `/api/stream/recordings/${encodeURIComponent(recording.id)}`;

  const act = async (
    kind: "rename" | "delete" | "unpublish",
    request: () => Promise<Response>,
    success: string,
  ) => {
    setPending(kind);
    try {
      const res = await request();
      if (!res.ok) throw new Error(await failureCopy(res));
      toast({ title: success });
      if (kind === "delete") onOpenChange(false);
      await onUpdated?.();
    } catch (error) {
      // A failed call may still have changed the row, so the list re-reads it.
      void onUpdated?.();
      toast({
        title: "That didn't work",
        description:
          error instanceof Error && !(error instanceof TypeError)
            ? error.message
            : friendlyFileError("NETWORK").description,
        variant: "destructive",
      });
    } finally {
      setPending(null);
      setConfirmingDelete(false);
    }
  };

  const onRename = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    void act(
      "rename",
      () =>
        fetch(base, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: trimmed }),
        }),
      "Title saved",
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex max-h-[100dvh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <SheetHeader className="shrink-0 space-y-1.5 border-b border-border px-6 py-5 text-left">
          <SheetTitle className="text-lg font-semibold">
            Manage recording
          </SheetTitle>
          <SheetDescription className="text-xs text-muted-foreground">
            {recording.whoCanWatch}
            {recording.keptUntil ? ` · ${recording.keptUntil}` : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <form onSubmit={onRename} className="space-y-2">
            <Label htmlFor="recording-title-input">Recording title</Label>
            <div className="flex gap-2">
              <Input
                id="recording-title-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                required
              />
              <Button
                type="submit"
                variant="outline"
                disabled={pending !== null || !title.trim()}
              >
                {pending === "rename" ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <>
                    <Save className="mr-1.5 h-4 w-4" aria-hidden />
                    Save
                  </>
                )}
              </Button>
            </div>
          </form>

          <section className="space-y-2">
            {!confirmingDelete ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canDelete || pending !== null}
                className="border-destructive/30 text-destructive hover:bg-destructive/10"
                onClick={() => setConfirmingDelete(true)}
              >
                <Trash2 className="mr-1.5 h-4 w-4" aria-hidden />
                Delete recording
              </Button>
            ) : (
              <div className="space-y-2.5 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                <p className="text-xs font-medium text-destructive">
                  Delete this recording permanently? Attendees are told it was
                  removed, and it can&apos;t be recovered.
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={pending !== null}
                    onClick={() =>
                      void act(
                        "delete",
                        () => fetch(base, { method: "DELETE" }),
                        "Recording deleted",
                      )
                    }
                  >
                    {pending === "delete" && (
                      <Loader2
                        className="mr-1.5 h-3.5 w-3.5 animate-spin"
                        aria-hidden
                      />
                    )}
                    Delete
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending !== null}
                    onClick={() => setConfirmingDelete(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            {recording.hasBuyers && (
              <p className="text-xs text-muted-foreground">
                Recordings that have been bought can&apos;t be deleted: buyers
                keep access.
              </p>
            )}
          </section>

          {(recording.sharedAcrossRuns !== null ||
            recording.listingStatus === "PUBLISHED") && (
            <section className="space-y-2 border-t border-border pt-5">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Sharing
              </h3>
              {recording.sharedAcrossRuns !== null && (
                <p className="text-xs text-muted-foreground">
                  Shared with attendees of every run:{" "}
                  {recording.sharedAcrossRuns ? "yes" : "no"} (set on the
                  offering)
                </p>
              )}
              {recording.listingStatus === "PUBLISHED" && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending !== null}
                  onClick={() =>
                    void act(
                      "unpublish",
                      () => fetch(`${base}/publish`, { method: "DELETE" }),
                      "Listing withdrawn",
                    )
                  }
                >
                  {pending === "unpublish" && (
                    <Loader2
                      className="mr-1.5 h-3.5 w-3.5 animate-spin"
                      aria-hidden
                    />
                  )}
                  Withdraw the existing listing
                </Button>
              )}
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
