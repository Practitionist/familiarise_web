"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
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
  Upload,
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
  listingStatus?: "DRAFT" | "PUBLISHED" | "UNPUBLISHED" | string | null;
  listPricePaise?: number | null;
  listingTitle?: string | null;
  listingDescription?: string | null;
  slug?: string | null;
  tags?: string[] | null;
  previewClipUrl?: string | null;
  previewTranscript?: string | null;
  consentAttestedAt?: string | null;
}

export interface RecordingManageSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recording: ManagedRecordingData | null;
  onUpdated?: () => void | Promise<void>;
}

export function RecordingManageSheet({
  open,
  onOpenChange,
  recording,
  onUpdated,
}: Readonly<RecordingManageSheetProps>) {
  const { toast } = useToast();

  // Details & Actions state
  const [title, setTitle] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const [isTransferring, setIsTransferring] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Marketplace Publish state
  const [listingTitle, setListingTitle] = useState("");
  const [listingDescription, setListingDescription] = useState("");
  const [priceInRupees, setPriceInRupees] = useState("");
  const [tags, setTags] = useState("");
  const [slug, setSlug] = useState("");
  const [previewTranscript, setPreviewTranscript] = useState("");
  const [previewClipFile, setPreviewClipFile] = useState<File | null>(null);
  const [consentAttested, setConsentAttested] = useState(false);
  const [isUploadingPreview, setIsUploadingPreview] = useState(false);
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
  const listingStatus = recording.listingStatus ?? "DRAFT";
  const isPublished = listingStatus === "PUBLISHED";
  const isPermanentStorage =
    recording.storageType === "PLATFORM" ||
    recording.storageType === "SUPABASE";

  const handleRename = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;

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
    setIsUploadingPreview(true);
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
      toast({
        title: "Preview Clip Uploaded",
        description: "Preview video uploaded to marketplace storage.",
      });
      return true;
    } catch (err) {
      toast({
        title: "Preview Upload Failed",
        description:
          err instanceof Error ? err.message : "Could not upload preview clip",
        variant: "destructive",
      });
      return false;
    } finally {
      setIsUploadingPreview(false);
    }
  };

  const handlePublish = async (e: FormEvent) => {
    e.preventDefault();
    if (!consentAttested) {
      toast({
        title: "Consent Required",
        description:
          "Please attest that attendees consented to redistributing this replay.",
        variant: "destructive",
      });
      return;
    }

    const numericPrice = Number(priceInRupees);
    const listPricePaise = Math.round(numericPrice * 100);
    if (!Number.isFinite(listPricePaise) || listPricePaise < 100) {
      toast({
        title: "Invalid Price",
        description: "Please enter a valid price of at least ₹1.",
        variant: "destructive",
      });
      return;
    }

    setIsPublishing(true);
    try {
      if (previewClipFile) {
        const uploaded = await uploadPreviewClip(previewClipFile);
        if (!uploaded) {
          setIsPublishing(false);
          return;
        }
      }

      const parsedTags = tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      const response = await fetch(
        `/api/stream/recordings/${recording.id}/publish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            listingTitle: listingTitle.trim(),
            listingDescription: listingDescription.trim() || undefined,
            listPricePaise,
            tags: parsedTags.length > 0 ? parsedTags : undefined,
            slug: slug.trim() || undefined,
            consentAttested: true,
            previewTranscript: previewTranscript.trim() || undefined,
          }),
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "Failed to publish recording");
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
          {/* Details & Actions Section */}
          <section className="space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Details &amp; Actions
            </h3>

            <form onSubmit={(e) => void handleRename(e)} className="space-y-2">
              <Label htmlFor="recording-title-input">Recording Title</Label>
              <div className="flex gap-2">
                <Input
                  id="recording-title-input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Session recording title"
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

            {recording.storageType === "STREAM_S3" && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3.5 space-y-2.5">
                <div className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>
                    This recording is currently stored in temporary Stream
                    storage (expires in 14 days). Transfer it to permanent cloud
                    storage to retain it indefinitely.
                  </span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => void handleTransfer()}
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

            <div className="pt-1">
              {!confirmingDelete ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
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
                      disabled={isDeleting}
                      onClick={() => void handleDelete()}
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
            </div>
          </section>

          {/* Replay Marketplace Publishing Section */}
          {isGroupRecording && (
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
                    isPublished
                      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : listingStatus === "UNPUBLISHED"
                        ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                        : "bg-muted text-muted-foreground",
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
                  <div className="flex items-center gap-2">
                    <Input
                      id="preview-clip-file"
                      type="file"
                      accept="video/mp4,video/webm"
                      onChange={(e) =>
                        setPreviewClipFile(e.target.files?.[0] ?? null)
                      }
                    />
                    {previewClipFile && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={isUploadingPreview}
                        onClick={() => void uploadPreviewClip(previewClipFile)}
                      >
                        {isUploadingPreview ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <>
                            <Upload className="mr-1 h-3.5 w-3.5" />
                            Upload
                          </>
                        )}
                      </Button>
                    )}
                  </div>
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
