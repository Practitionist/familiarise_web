"use client";

import { useState, useRef, useCallback } from "react";
import Image from "next/image";
import { Camera, X, Upload, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface ProfileDisplayImageUploaderProps {
  currentImage?: string | null;
  userId: string;
  onUploadSuccess?: (imageUrl: string) => void;
  onDeleteSuccess?: () => void;
  className?: string;
  editable?: boolean;
}

const ALLOWED_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
const MAX_SIZE = 2 * 1024 * 1024; // 2MB for profile images

export function ProfileDisplayImageUploader({
  currentImage,
  userId,
  onUploadSuccess,
  onDeleteSuccess,
  className,
  editable = true,
}: ProfileDisplayImageUploaderProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const displayImage = previewUrl || currentImage;

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
          description: "Please upload an image smaller than 2MB.",
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

        const response = await fetch("/api/user/profile-display-image", {
          method: "POST",
          body: formData,
        });

        const result = await response.json();

        if (!response.ok || !result.success) {
          throw new Error(result.error || "Failed to upload image");
        }

        toast({
          title: "Profile image updated",
          description:
            "Your profile display image has been uploaded successfully.",
        });

        onUploadSuccess?.(result.data.profileDisplayImage);
      } catch (error) {
        console.error("Upload error:", error);
        setPreviewUrl(null);
        toast({
          title: "Upload failed",
          description:
            error instanceof Error
              ? error.message
              : "Failed to upload profile image. Please try again.",
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
    if (!currentImage && !previewUrl) return;

    setIsDeleting(true);
    try {
      const response = await fetch(
        `/api/user/profile-display-image?userId=${userId}`,
        {
          method: "DELETE",
        },
      );

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || "Failed to delete image");
      }

      setPreviewUrl(null);
      toast({
        title: "Profile image removed",
        description: "Your profile display image has been deleted.",
      });

      onDeleteSuccess?.();
    } catch (error) {
      console.error("Delete error:", error);
      toast({
        title: "Delete failed",
        description:
          error instanceof Error
            ? error.message
            : "Failed to delete profile image. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
    }
  }, [currentImage, previewUrl, userId, toast, onDeleteSuccess]);

  const handleButtonClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className={cn("relative", className)}>
      {/* Square Profile Image Container */}
      <div className="relative w-48 h-48 bg-zinc-100 dark:bg-zinc-800 rounded-xl overflow-hidden ring-4 ring-zinc-200 dark:ring-zinc-700">
        {displayImage ? (
          <Image
            src={displayImage}
            alt="Profile display image"
            fill
            className="object-cover"
            sizes="192px"
            priority
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center text-zinc-400 dark:text-zinc-600">
              <Camera className="w-10 h-10 mx-auto mb-2" />
              <p className="text-xs">No image</p>
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

      {/* Edit Controls */}
      {editable && (
        <div className="flex gap-2 mt-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleButtonClick}
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
      )}

      {/* Help text */}
      <p className="text-xs text-zinc-500 mt-2">
        Square image (1:1), max 2MB. This will be displayed on your expert
        profile.
      </p>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_TYPES.join(",")}
        onChange={handleFileSelect}
        className="hidden"
        aria-label="Upload profile display image"
      />
    </div>
  );
}

export default ProfileDisplayImageUploader;
