"use client";

import { useRef, useState, useCallback } from "react";
import Image from "next/image";
import { ImageIcon, X, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/utils/tailwind";
import type { TPlanImageType } from "@/lib/supabase";

/** A cover-image change held in the editor until the offering is saved. */
export type StagedPlanImage =
  { kind: "upload"; file: File } | { kind: "remove" };

interface IPlanImageUploaderProps {
  currentImageUrl?: string | null;
  staged: StagedPlanImage | null;
  onStage: (change: StagedPlanImage | null) => void;
  className?: string;
}

const ALLOWED_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

/** Writes a staged change through /api/plans/image, the only writer of a plan's imageUrl. */
export async function commitPlanImage(
  planType: TPlanImageType,
  planId: string,
  change: StagedPlanImage,
): Promise<void> {
  let response: Response;
  if (change.kind === "upload") {
    const formData = new FormData();
    formData.append("file", change.file);
    formData.append("planType", planType);
    formData.append("planId", planId);
    response = await fetch("/api/plans/image", {
      method: "POST",
      body: formData,
    });
  } else {
    response = await fetch("/api/plans/image", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planType, planId }),
    });
  }
  if (!response.ok) {
    const result = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(result.error || "Couldn't update the cover image");
  }
}

export function PlanImageUploader({
  currentImageUrl,
  staged,
  onStage,
  className,
}: Readonly<IPlanImageUploaderProps>) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const previewRef = useRef<string | null>(null);

  const replacePreview = useCallback((file: File | null) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = file ? URL.createObjectURL(file) : null;
    setPreviewUrl(previewRef.current);
  }, []);

  let displayImage = currentImageUrl ?? null;
  if (staged?.kind === "upload") displayImage = previewUrl;
  if (staged?.kind === "remove") displayImage = null;

  const handleFileSelect = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;

      if (!ALLOWED_TYPES.includes(file.type)) {
        toast({
          title: "Invalid file type",
          description: "Please upload a JPEG, PNG, or WebP image.",
          variant: "destructive",
        });
        return;
      }

      if (file.size > MAX_SIZE) {
        toast({
          title: "File too large",
          description: "Please upload an image smaller than 5MB.",
          variant: "destructive",
        });
        return;
      }

      replacePreview(file);
      onStage({ kind: "upload", file });
    },
    [toast, onStage, replacePreview],
  );

  // Removing a not-yet-saved pick just drops it; removing the saved image is staged.
  const handleRemove = useCallback(() => {
    const pickedOnly = staged?.kind === "upload" || !currentImageUrl;
    replacePreview(null);
    onStage(pickedOnly ? null : { kind: "remove" });
  }, [staged, currentImageUrl, onStage, replacePreview]);

  return (
    <div className={cn("space-y-3", className)}>
      {/* Cover Image Preview */}
      <div className="relative w-full h-40 bg-zinc-100 dark:bg-zinc-800 rounded-lg overflow-hidden border border-zinc-200 dark:border-zinc-700">
        {displayImage ? (
          <Image
            src={displayImage}
            alt="Plan cover image"
            fill
            className="object-cover"
            sizes="(max-width: 768px) 100vw, 600px"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center text-zinc-400 dark:text-zinc-600">
              <ImageIcon className="w-8 h-8 mx-auto mb-2" />
              <p className="text-xs">No cover image</p>
            </div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="w-4 h-4 mr-2" />
          {displayImage ? "Change" : "Upload"}
        </Button>

        {displayImage && (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={handleRemove}
          >
            <X className="w-4 h-4 mr-2" />
            Remove
          </Button>
        )}
      </div>

      <p className="text-xs text-zinc-500">
        Cover image, max 5MB. JPEG, PNG, or WebP.
        {staged && " Saved when you save the offering."}
      </p>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_TYPES.join(",")}
        onChange={handleFileSelect}
        className="hidden"
        aria-label="Upload plan cover image"
      />
    </div>
  );
}
