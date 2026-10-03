"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import type { RecordingListingStatus } from "@prisma/client";
import { z } from "zod";
import {
  AlertTriangle,
  CheckCircle2,
  CloudUpload,
  ExternalLink,
  Globe,
  Loader2,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import type { RecordingData } from "@/types/recording";
import { cn } from "@/utils/tailwind";

export type ConsultantRecordingType =
  "webinar" | "class" | "consultation" | "subscription" | "trial";

export interface ManagedRecordingData extends Omit<RecordingData, "planType"> {
  planType: ConsultantRecordingType | null;
  listingStatus?: RecordingListingStatus | null;
  listPricePaise?: number | null;
  listingTitle?: string | null;
  listingDescription?: string | null;
  slug?: string | null;
  tags?: string[] | null;
  previewClipUrl?: string | null;
  previewTranscript?: string | null;
  consentAttestedAt?: string | null;
  hasBuyers?: boolean;
  canManage?: boolean;
  canTransfer?: boolean;
  canPublish?: boolean;
}

export interface RecordingManageSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly recording: ManagedRecordingData | null;
  readonly onUpdated?: () => void | Promise<void>;
}

export const ClientPublishSchema = z.object({
  listingTitle: z
    .string()
    .trim()
    .min(3, "Listing title must be at least 3 characters.")
    .max(120, "Listing title must be at most 120 characters."),
  listingDescription: z
    .string()
    .trim()
    .max(2000, "Listing description must be at most 2,000 characters.")
    .optional(),
  listPricePaise: z
    .number()
    .int()
    .min(100, "Please enter a valid price of at least ₹1.")
    .max(100_000_000, "Price cannot exceed ₹10,00,000."),
  tags: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(30, "Each tag must be at most 30 characters."),
    )
    .max(8, "You can add at most 8 tags.")
    .optional(),
  slug: z
    .string()
    .trim()
    .min(3, "Custom slug must be at least 3 characters.")
    .max(80, "Custom slug must be at most 80 characters.")
    .regex(
      /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
      "Custom slug can only use lowercase letters, digits, and hyphens.",
    )
    .optional(),
  consentAttested: z.literal(true, {
    errorMap: () => ({
      message:
        "Please attest that attendees consented to redistributing this replay.",
    }),
  }),
  previewTranscript: z
    .string()
    .trim()
    .min(1)
    .max(20_000, "Preview transcript must be at most 20,000 characters.")
    .optional(),
});

export function canDeleteRecording(
  recording: Pick<ManagedRecordingData, "hasBuyers" | "canManage">,
): boolean {
  return (recording.canManage ?? true) && !recording.hasBuyers;
}

function getListingStatusBadgeClass(
  listingStatus: RecordingListingStatus,
): string {
  if (listingStatus === "PUBLISHED") {
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (listingStatus === "UNPUBLISHED") {
    return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  return "bg-muted text-muted-foreground";
}

interface RecordingDetailsSectionProps {
  readonly recording: ManagedRecordingData;
  readonly title: string;
  readonly setTitle: (value: string) => void;
  readonly isRenaming: boolean;
  readonly onRename: (e: FormEvent) => Promise<void>;
  readonly canTransfer: boolean;
  readonly isTransferring: boolean;
  readonly onTransfer: () => Promise<void>;
  readonly canDelete: boolean;
  readonly confirmingDelete: boolean;
  readonly setConfirmingDelete: (value: boolean) => void;
  readonly isDeleting: boolean;
  readonly onDelete: () => Promise<void>;
}

function RecordingDetailsSection({
  recording,
  title,
  setTitle,
  isRenaming,
  onRename,
  canTransfer,
  isTransferring,
  onTransfer,
  canDelete,
  confirmingDelete,
  setConfirmingDelete,
  isDeleting,
  onDelete,
}: Readonly<RecordingDetailsSectionProps>) {
  return (
    <section className="space-y-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Details &amp; Actions
      </h3>

      <form onSubmit={(e) => void onRename(e)} className="space-y-2">
        <Label htmlFor="recording-title-input">Recording Title</Label>
        <div className="flex gap-2">
          <Input
            id="recording-title-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Session recording title"
            maxLength={200}
            required
          />
          <Button
            type="submit"
            variant="outline"
            disabled={isRenaming || !title.trim()}
          >
            {isRenaming ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <Save className="mr-1.5 h-4 w-4" />
                Save
              </>
            )}
          </Button>
        </div>
      </form>

      {canTransfer && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3.5 space-y-2.5">
          <div className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              This recording is currently stored in temporary Stream storage
              (expires in 14 days). Transfer it to permanent cloud storage to
              retain it indefinitely.
            </span>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => void onTransfer()}
            disabled={isTransferring}
          >
            {isTransferring ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <CloudUpload className="mr-2 h-4 w-4" />
            )}
            Transfer to Permanent Storage
          </Button>
        </div>
      )}

      <div className="pt-1 space-y-2">
        {!confirmingDelete ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canDelete}
            className="text-destructive border-destructive/30 hover:bg-destructive/10"
            onClick={() => setConfirmingDelete(true)}
          >
            <Trash2 className="mr-1.5 h-4 w-4" />
            Delete Recording
          </Button>
        ) : (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 space-y-2.5">
            <p className="text-xs font-medium text-destructive">
              Are you sure you want to permanently delete this recording?
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={isDeleting || !canDelete}
                onClick={() => void onDelete()}
              >
                {isDeleting ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : null}
                Confirm Delete
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isDeleting}
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
        {recording.hasBuyers && (
          <p className="text-xs text-muted-foreground">
            Recordings with completed marketplace purchases cannot be deleted
            because buyers retain lifetime access.
          </p>
        )}
      </div>
    </section>
  );
}

export function RecordingManageSheet({
  open,
  onOpenChange,
  recording,
  onUpdated,
}: Readonly<RecordingManageSheetProps>) {
  const { toast } = useToast();

  const [title, setTitle] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const [isTransferring, setIsTransferring] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const [listingTitle, setListingTitle] = useState("");
  const [listingDescription, setListingDescription] = useState("");
  const [priceInRupees, setPriceInRupees] = useState("");
  const [tags, setTags] = useState("");
  const [slug, setSlug] = useState("");
  const [previewTranscript, setPreviewTranscript] = useState("");
  const [previewClipFile, setPreviewClipFile] = useState<File | null>(null);
  const [consentAttested, setConsentAttested] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isUnpublishing, setIsUnpublishing] = useState(false);

  useEffect(() => {
    if (!recording || !open) {
      setConfirmingDelete(false);
      setPreviewClipFile(null);
      return;
    }

    setTitle(recording.title ?? "");
    setListingTitle(recording.listingTitle ?? recording.title ?? "");
    setListingDescription(recording.listingDescription ?? "");
    setPriceInRupees(
      typeof recording.listPricePaise === "number" &&
        recording.listPricePaise > 0
        ? String(recording.listPricePaise / 100)
        : "",
    );
    setTags(Array.isArray(recording.tags) ? recording.tags.join(", ") : "");
    setSlug(recording.slug ?? "");
    setPreviewTranscript(recording.previewTranscript ?? "");
    setConsentAttested(Boolean(recording.consentAttestedAt));
    setConfirmingDelete(false);
    setPreviewClipFile(null);
  }, [recording, open]);

  if (!recording) return null;

  const isGroupRecording =
    recording.planType === "webinar" || recording.planType === "class";
  const canShowMarketplace = recording.canPublish ?? isGroupRecording;
  const canTransfer =
    recording.canTransfer ??
    (recording.status === "READY" && recording.storageType === "STREAM_S3");
  const canDelete = canDeleteRecording(recording);
  const listingStatus: RecordingListingStatus =
    recording.listingStatus ?? "DRAFT";
  const isPublished = listingStatus === "PUBLISHED";
  const isPermanentStorage =
    recording.status === "AVAILABLE" && recording.storageType === "PLATFORM";

  const handleRename = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || trimmed.length > 200) {
      toast({
        title: "Invalid Title",
        description: "Recording title must be between 1 and 200 characters.",
        variant: "destructive",
      });
      return;
    }

    setIsRenaming(true);
    try {
      const response = await fetch(`/api/stream/recordings/${recording.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "Failed to update recording title");
      }
      toast({
        title: "Title Updated",
        description: "Recording title has been saved.",
      });
      await onUpdated?.();
    } catch (err) {
      toast({
        title: "Rename Failed",
        description:
          err instanceof Error ? err.message : "Could not rename recording",
        variant: "destructive",
      });
    } finally {
      setIsRenaming(false);
    }
  };

  const handleTransfer = async () => {
    setIsTransferring(true);
    try {
      const response = await fetch(
        `/api/stream/recordings/${recording.id}/transfer`,
        {
          method: "POST",
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(
          payload.error || "Failed to transfer recording to permanent storage",
        );
      }
      toast({
        title: "Transfer Complete",
        description: "Recording transferred to permanent cloud storage.",
      });
      await onUpdated?.();
    } catch (err) {
      toast({
        title: "Transfer Failed",
        description:
          err instanceof Error ? err.message : "Could not transfer recording",
        variant: "destructive",
      });
    } finally {
      setIsTransferring(false);
    }
  };

  const handleDelete = async () => {
    if (!canDelete) return;
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/stream/recordings/${recording.id}`, {
        method: "DELETE",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "Failed to delete recording");
      }
      toast({
        title: "Recording Deleted",
        description: "The recording has been removed.",
      });
      onOpenChange(false);
      await onUpdated?.();
    } catch (err) {
      toast({
        title: "Delete Failed",
        description:
          err instanceof Error ? err.message : "Could not delete recording",
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
      setConfirmingDelete(false);
    }
  };

  const uploadPreviewClip = async (file: File): Promise<boolean> => {
    try {
      const formData = new FormData();
      formData.append("clip", file);
      const response = await fetch(
        `/api/stream/recordings/${recording.id}/preview`,
        {
          method: "POST",
          body: formData,
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "Failed to upload preview clip");
      }
      setPreviewClipFile(null);
      return true;
    } catch (err) {
      toast({
        title: "Preview Upload Failed",
        description:
          err instanceof Error
            ? `${err.message}. Listing was saved, but preview clip upload failed.`
            : "Listing was saved, but preview clip upload failed.",
        variant: "destructive",
      });
      return false;
    }
  };

  const handlePublish = async (e: FormEvent) => {
    e.preventDefault();
    const numericPrice = Number(priceInRupees);
    const listPricePaise = Number.isFinite(numericPrice)
      ? Math.round(numericPrice * 100)
      : NaN;
    const parsedTags = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const trimmedTranscript = previewTranscript.trim();
    const hasPreviewClip = Boolean(previewClipFile || recording.previewClipUrl);

    if (hasPreviewClip && !trimmedTranscript) {
      toast({
        title: "Transcript Required",
        description:
          "Please provide a text transcript whenever a preview clip is attached.",
        variant: "destructive",
      });
      return;
    }

    const validation = ClientPublishSchema.safeParse({
      listingTitle: listingTitle.trim(),
      listingDescription: listingDescription.trim() || undefined,
      listPricePaise,
      tags: parsedTags.length > 0 ? parsedTags : undefined,
      slug: slug.trim() || undefined,
      consentAttested: consentAttested ? true : undefined,
      previewTranscript: trimmedTranscript || undefined,
    });

    if (!validation.success) {
      toast({
        title: "Validation Error",
        description:
          validation.error.issues[0]?.message ??
          "Please check your listing details.",
        variant: "destructive",
      });
      return;
    }

    setIsPublishing(true);
    try {
      const response = await fetch(
        `/api/stream/recordings/${recording.id}/publish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validation.data),
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "Failed to publish recording");
      }

      if (previewClipFile) {
        await uploadPreviewClip(previewClipFile);
      }

      toast({
        title: "Published to Marketplace",
        description: "Your replay listing is now live on Explore Recordings.",
      });
      await onUpdated?.();
    } catch (err) {
      toast({
        title: "Publish Failed",
        description:
          err instanceof Error ? err.message : "Could not publish recording",
        variant: "destructive",
      });
    } finally {
      setIsPublishing(false);
    }
  };

  const handleUnpublish = async () => {
    setIsUnpublishing(true);
    try {
      const response = await fetch(
        `/api/stream/recordings/${recording.id}/publish`,
        {
          method: "DELETE",
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "Failed to unpublish recording");
      }
      toast({
        title: "Unpublished",
        description:
          "Replay listing has been withdrawn from the public marketplace.",
      });
      await onUpdated?.();
    } catch (err) {
      toast({
        title: "Unpublish Failed",
        description:
          err instanceof Error ? err.message : "Could not unpublish recording",
        variant: "destructive",
      });
    } finally {
      setIsUnpublishing(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-lg max-h-[100dvh]">
        <SheetHeader className="shrink-0 space-y-1.5 border-b border-border px-6 py-5 text-left">
          <SheetTitle className="text-lg font-semibold">
            Manage Recording
          </SheetTitle>
          <SheetDescription className="text-xs text-muted-foreground">
            Update recording details, manage cloud storage, or publish group
            session replays to the marketplace.
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 space-y-6">
          <RecordingDetailsSection
            recording={recording}
            title={title}
            setTitle={setTitle}
            isRenaming={isRenaming}
            onRename={handleRename}
            canTransfer={canTransfer}
            isTransferring={isTransferring}
            onTransfer={handleTransfer}
            canDelete={canDelete}
            confirmingDelete={confirmingDelete}
            setConfirmingDelete={setConfirmingDelete}
            isDeleting={isDeleting}
            onDelete={handleDelete}
          />

          {canShowMarketplace && (
            <section className="space-y-4 border-t border-border pt-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="h-4 w-4 text-primary" />
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Replay Marketplace Publishing
                  </h3>
                </div>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
                    getListingStatusBadgeClass(listingStatus),
                  )}
                >
                  {isPublished && <CheckCircle2 className="h-3 w-3" />}
                  {listingStatus}
                </span>
              </div>

              {isPublished && recording.slug && (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs">
                  <span className="inline-flex items-center gap-1.5 text-emerald-800 dark:text-emerald-300 font-medium truncate">
                    <Globe className="h-3.5 w-3.5 shrink-0" />
                    /explore/recordings/{recording.slug}
                  </span>
                  <Link
                    href={`/explore/recordings/${recording.slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-primary hover:underline shrink-0"
                  >
                    View Listing
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                </div>
              )}

              {!isPermanentStorage && (
                <p className="rounded-lg border border-border bg-muted p-3 text-xs text-muted-foreground">
                  Transfer this recording to permanent storage above before
                  publishing it to the Replay Marketplace.
                </p>
              )}

              <form
                onSubmit={(e) => void handlePublish(e)}
                className="space-y-4"
              >
                <div className="space-y-1.5">
                  <Label htmlFor="listing-title">Listing Title</Label>
                  <Input
                    id="listing-title"
                    value={listingTitle}
                    onChange={(e) => setListingTitle(e.target.value)}
                    placeholder="Public title for marketplace buyers"
                    minLength={3}
                    maxLength={120}
                    required
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="listing-description">
                    Listing Description
                  </Label>
                  <Textarea
                    id="listing-description"
                    value={listingDescription}
                    onChange={(e) => setListingDescription(e.target.value)}
                    placeholder="Describe what learners will gain from this recorded session..."
                    rows={3}
                    maxLength={2000}
                  />
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="price-in-rupees">Price (INR ₹)</Label>
                    <Input
                      id="price-in-rupees"
                      type="number"
                      min="1"
                      max="1000000"
                      step="1"
                      value={priceInRupees}
                      onChange={(e) => setPriceInRupees(e.target.value)}
                      placeholder="499"
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="listing-slug">Custom Slug (optional)</Label>
                    <Input
                      id="listing-slug"
                      value={slug}
                      onChange={(e) => setSlug(e.target.value)}
                      placeholder="system-design-deep-dive"
                      minLength={3}
                      maxLength={80}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="listing-tags">Tags (comma-separated)</Label>
                  <Input
                    id="listing-tags"
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    placeholder="system-design, architecture, interviews"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="preview-clip-file">
                    Preview Clip (MP4 or WebM, optional)
                  </Label>
                  <Input
                    id="preview-clip-file"
                    type="file"
                    accept="video/mp4,video/webm"
                    onChange={(e) =>
                      setPreviewClipFile(e.target.files?.[0] ?? null)
                    }
                  />
                  {recording.previewClipUrl && (
                    <p className="text-xs text-muted-foreground">
                      Current preview clip uploaded.
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="preview-transcript">
                    Preview Transcript / Notes
                  </Label>
                  <Textarea
                    id="preview-transcript"
                    value={previewTranscript}
                    onChange={(e) => setPreviewTranscript(e.target.value)}
                    placeholder="Text transcript for the preview clip (required when a preview clip is attached)..."
                    rows={3}
                    maxLength={20000}
                  />
                </div>

                <div className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 p-3">
                  <Checkbox
                    id="consent-attested"
                    checked={consentAttested}
                    onCheckedChange={(checked) =>
                      setConsentAttested(checked === true)
                    }
                  />
                  <Label
                    htmlFor="consent-attested"
                    className="text-xs leading-relaxed text-muted-foreground cursor-pointer"
                  >
                    I attest that all participants in this session were notified
                    of recording and consented to commercial redistribution on
                    the Replay Marketplace.
                  </Label>
                </div>

                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    type="submit"
                    className="flex-1"
                    disabled={isPublishing || !isPermanentStorage}
                  >
                    {isPublishing ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : null}
                    {isPublished
                      ? "Update Marketplace Listing"
                      : "Publish to Marketplace"}
                  </Button>

                  {isPublished && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={isUnpublishing}
                      onClick={() => void handleUnpublish()}
                    >
                      {isUnpublishing ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : null}
                      Unpublish from Marketplace
                    </Button>
                  )}
                </div>
              </form>
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
