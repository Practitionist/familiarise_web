"use client";

import { useState, useRef, useCallback } from "react";
import Image from "next/image";
import { ImageIcon, X, Upload, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/utils/tailwind";
import type { TPlanImageType } from "@/lib/supabase";

interface IPlanImageUploaderProps {
  planType: TPlanImageType;
  planId: string;
  currentImageUrl?: string | null;
  onImageChange?: (url: string | null) => void;
  className?: string;
}

const ALLOWED_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

export function PlanImageUploader({
  planType,
  planId,
  currentImageUrl,
  onImageChange,
  className,
}: IPlanImageUploaderProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const displayImage = previewUrl || currentImageUrl;

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
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

      const objectUrl = URL.createObjectURL(file);
      setPreviewUrl(objectUrl);

      setIsUploading(true);
      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("planType", planType);
        formData.append("planId", planId);

        const response = await fetch("/api/plans/image", {
          method: "POST",
          body: formData,
        });

        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error || "Failed to upload image");
        }

        toast({
          title: "Cover image updated",
          description: "Your plan cover image has been uploaded successfully.",
        });

        onImageChange?.(result.imageUrl);
      } catch (error) {
        console.error("Upload error:", error);
        setPreviewUrl(null);
        toast({
          title: "Upload failed",
          description:
            error instanceof Error
              ? error.message
              : "Failed to upload cover image. Please try again.",
          variant: "destructive",
        });
      } finally {
        setIsUploading(false);
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      }
    },
    [planType, planId, toast, onImageChange],
  );

  const handleDelete = useCallback(async () => {
    if (!currentImageUrl && !previewUrl) return;

    setIsDeleting(true);
    try {
      const response = await fetch("/api/plans/image", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planType, planId }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Failed to delete image");
      }

      setPreviewUrl(null);
      toast({
        title: "Cover image removed",
        description: "Your plan cover image has been deleted.",
      });

      onImageChange?.(null);
    } catch (error) {
      console.error("Delete error:", error);
      toast({
        title: "Delete failed",
        description:
          error instanceof Error
            ? error.message
            : "Failed to delete cover image. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
    }
  }, [currentImageUrl, previewUrl, planType, planId, toast, onImageChange]);

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

        {/* Loading overlay */}
        {(isUploading || isDeleting) && (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
            <div className="text-white text-center">
              <Loader2 className="w-6 h-6 animate-spin mx-auto mb-1" />
              <p className="text-xs">
                {isUploading ? "Uploading..." : "Removing..."}
              </p>
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
          disabled={isUploading || isDeleting}
        >
          <Upload className="w-4 h-4 mr-2" />
          {displayImage ? "Change" : "Upload"}
        </Button>

        {displayImage && (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={handleDelete}
            disabled={isUploading || isDeleting}
          >
            <X className="w-4 h-4 mr-2" />
            Remove
          </Button>
        )}
      </div>

      <p className="text-xs text-zinc-500">
        Cover image, max 5MB. JPEG, PNG, or WebP.
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
