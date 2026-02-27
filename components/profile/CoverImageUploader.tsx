"use client";

import { useState, useRef, useCallback } from "react";
import Image from "next/image";
import { Camera, X, Upload, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/utils/tailwind";

interface CoverImageUploaderProps {
  currentCoverImage?: string | null;
  userId: string;
  onUploadSuccess?: (imageUrl: string) => void;
  onDeleteSuccess?: () => void;
  className?: string;
  editable?: boolean;
}

const ALLOWED_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

export function CoverImageUploader({
  currentCoverImage,
  userId,
  onUploadSuccess,
  onDeleteSuccess,
  className,
  editable = true,
}: CoverImageUploaderProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const displayImage = previewUrl || currentCoverImage;

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      // Validate file type
      if (!ALLOWED_TYPES.includes(file.type)) {
        toast({
          title: "Invalid file type",
          description: "Please upload a JPEG, PNG, or WebP image.",
          variant: "destructive",
        });
        return;
      }

      // Validate file size
      if (file.size > MAX_SIZE) {
        toast({
          title: "File too large",
          description: "Please upload an image smaller than 5MB.",
          variant: "destructive",
        });
        return;
      }

      // Create preview
      const objectUrl = URL.createObjectURL(file);
      setPreviewUrl(objectUrl);

      // Upload file
      setIsUploading(true);
      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("userId", userId);

        const response = await fetch("/api/user/cover-image", {
          method: "POST",
          body: formData,
        });

        const result = await response.json();

        if (!response.ok || !result.success) {
          throw new Error(result.error || "Failed to upload image");
        }

        toast({
          title: "Cover image updated",
          description: "Your cover image has been uploaded successfully.",
        });

        onUploadSuccess?.(result.data.coverImage);
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
        // Reset file input
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      }
    },
    [userId, toast, onUploadSuccess],
  );

  const handleDelete = useCallback(async () => {
    if (!currentCoverImage && !previewUrl) return;

    setIsDeleting(true);
    try {
      const response = await fetch(`/api/user/cover-image?userId=${userId}`, {
        method: "DELETE",
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || "Failed to delete image");
      }

      setPreviewUrl(null);
      toast({
        title: "Cover image removed",
        description: "Your cover image has been deleted.",
      });

      onDeleteSuccess?.();
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
  }, [currentCoverImage, previewUrl, userId, toast, onDeleteSuccess]);

  const handleButtonClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className={cn("relative w-full", className)}>
      {/* Cover Image Container */}
      <div className="relative w-full h-48 md:h-64 lg:h-80 bg-gradient-to-r from-zinc-200 to-zinc-300 dark:from-zinc-800 dark:to-zinc-900 rounded-lg overflow-hidden">
        {displayImage ? (
          <Image
            src={displayImage}
            alt="Cover image"
            fill
            className="object-cover"
            sizes="(max-width: 768px) 100vw, (max-width: 1200px) 80vw, 1200px"
            priority
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center text-zinc-400 dark:text-zinc-600">
              <Camera className="w-12 h-12 mx-auto mb-2" />
              <p className="text-sm">No cover image</p>
            </div>
          </div>
        )}

        {/* Loading overlay */}
        {(isUploading || isDeleting) && (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
            <div className="text-white text-center">
              <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />
              <p className="text-sm">
                {isUploading ? "Uploading..." : "Removing..."}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Edit Controls */}
      {editable && (
        <div className="absolute bottom-4 right-4 flex gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleButtonClick}
            disabled={isUploading || isDeleting}
            className="bg-white/90 hover:bg-white shadow-md"
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
              className="shadow-md"
            >
              <X className="w-4 h-4 mr-2" />
              Remove
            </Button>
          )}
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_TYPES.join(",")}
        onChange={handleFileSelect}
        className="hidden"
        aria-label="Upload cover image"
      />
    </div>
  );
}

export default CoverImageUploader;
