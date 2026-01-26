"use client";

import { useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import {
  Upload,
  X,
  FileText,
  Image,
  Loader2,
  CheckCircle,
  AlertCircle,
} from "lucide-react";

export interface UploadedDocument {
  id?: string;
  fileName: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
  fileUrl?: string;
  storagePath?: string;
  description?: string;
  status: "uploading" | "uploaded" | "error";
  progress?: number;
  error?: string;
  isOnboardingUpload?: boolean;
}

interface VerificationDocumentUploadProps {
  documents: UploadedDocument[];
  onDocumentsChange: (documents: UploadedDocument[]) => void;
  onUpload: (file: File, description?: string) => Promise<UploadedDocument>;
  onRemove?: (documentId: string) => Promise<void>;
  maxFiles?: number;
  maxSize?: number; // in bytes
  acceptedTypes?: string[];
  disabled?: boolean;
}

const DEFAULT_ACCEPTED_TYPES = [
  "image/png",
  "image/jpg",
  "image/jpeg",
  "image/webp",
  "application/pdf",
];

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024; // 10MB

export function VerificationDocumentUpload({
  documents,
  onDocumentsChange,
  onUpload,
  onRemove,
  maxFiles = 5,
  maxSize = DEFAULT_MAX_SIZE,
  acceptedTypes = DEFAULT_ACCEPTED_TYPES,
  disabled = false,
}: VerificationDocumentUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (disabled || uploading || !files) return;

      // Check if we can add more files
      const remainingSlots = maxFiles - documents.length;
      const filesToUpload = Array.from(files).slice(0, remainingSlots);

      if (filesToUpload.length === 0) return;

      setUploading(true);

      for (const file of filesToUpload) {
        // Validate file type
        if (!acceptedTypes.includes(file.type)) {
          const errorDoc: UploadedDocument = {
            fileName: file.name,
            originalName: file.name,
            fileSize: file.size,
            mimeType: file.type,
            status: "error",
            error: "Invalid file type",
          };
          onDocumentsChange([...documents, errorDoc]);
          continue;
        }

        // Validate file size
        if (file.size > maxSize) {
          const errorDoc: UploadedDocument = {
            fileName: file.name,
            originalName: file.name,
            fileSize: file.size,
            mimeType: file.type,
            status: "error",
            error: `File too large (max ${formatFileSize(maxSize)})`,
          };
          onDocumentsChange([...documents, errorDoc]);
          continue;
        }

        // Add placeholder
        const placeholder: UploadedDocument = {
          fileName: file.name,
          originalName: file.name,
          fileSize: file.size,
          mimeType: file.type,
          status: "uploading",
          progress: 0,
        };

        onDocumentsChange([...documents, placeholder]);

        try {
          const uploaded = await onUpload(file);
          onDocumentsChange([
            ...documents.filter((d) => d.fileName !== placeholder.fileName),
            uploaded,
          ]);
        } catch (error) {
          const errorDoc: UploadedDocument = {
            ...placeholder,
            status: "error",
            error: error instanceof Error ? error.message : "Upload failed",
          };
          onDocumentsChange([
            ...documents.filter((d) => d.fileName !== placeholder.fileName),
            errorDoc,
          ]);
        }
      }

      setUploading(false);
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [documents, onDocumentsChange, onUpload, maxFiles, maxSize, acceptedTypes, disabled, uploading]
  );

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles]
  );

  const handleRemove = async (doc: UploadedDocument) => {
    if (doc.id && onRemove) {
      try {
        await onRemove(doc.id);
      } catch {
        // Still remove from UI even if API fails
      }
    }
    onDocumentsChange(documents.filter((d) => d.fileName !== doc.fileName));
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getFileIcon = (mimeType: string) => {
    if (mimeType.startsWith("image/")) {
      return <Image className="w-5 h-5" />;
    }
    return <FileText className="w-5 h-5" />;
  };

  const canAddMore = documents.length < maxFiles && !disabled && !uploading;

  return (
    <div className="space-y-4">
      {/* Dropzone */}
      <div
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        onClick={() => canAddMore && fileInputRef.current?.click()}
        className={cn(
          "border-2 border-dashed rounded-lg p-6 text-center transition-colors",
          canAddMore ? "cursor-pointer" : "cursor-not-allowed",
          dragActive
            ? "border-primary bg-primary/5"
            : "border-zinc-200 hover:border-zinc-300",
          !canAddMore && "opacity-50"
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={acceptedTypes.join(",")}
          onChange={(e) => handleFiles(e.target.files)}
          className="hidden"
          multiple
          disabled={!canAddMore}
        />
        <Upload className="w-8 h-8 mx-auto mb-3 text-zinc-400" />
        {dragActive ? (
          <p className="text-sm text-primary">Drop the files here...</p>
        ) : (
          <>
            <p className="text-sm text-zinc-600">
              Drag & drop files here, or click to select
            </p>
            <p className="text-xs text-zinc-400 mt-1">
              PDF, PNG, JPG up to {formatFileSize(maxSize)} each (max {maxFiles}{" "}
              files)
            </p>
          </>
        )}
      </div>

      {/* Document List */}
      {documents.length > 0 && (
        <div className="space-y-2">
          {documents.map((doc, index) => (
            <div
              key={doc.id || doc.fileName + index}
              className={cn(
                "flex items-center gap-3 p-3 rounded-lg border",
                doc.status === "error"
                  ? "border-red-200 bg-red-50"
                  : "border-zinc-200 bg-zinc-50"
              )}
            >
              <div
                className={cn(
                  "flex-shrink-0",
                  doc.status === "error" ? "text-red-500" : "text-zinc-500"
                )}
              >
                {doc.status === "uploading" ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : doc.status === "error" ? (
                  <AlertCircle className="w-5 h-5" />
                ) : (
                  getFileIcon(doc.mimeType)
                )}
              </div>

              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {doc.originalName}
                </p>
                <p className="text-xs text-zinc-500">
                  {formatFileSize(doc.fileSize)}
                  {doc.status === "uploaded" && (
                    <span className="ml-2 text-green-600">
                      <CheckCircle className="w-3 h-3 inline mr-0.5" />
                      Uploaded
                    </span>
                  )}
                  {doc.status === "error" && (
                    <span className="ml-2 text-red-600">{doc.error}</span>
                  )}
                </p>
                {doc.status === "uploading" && doc.progress !== undefined && (
                  <Progress value={doc.progress} className="h-1 mt-1" />
                )}
              </div>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="flex-shrink-0 h-8 w-8"
                onClick={(e) => {
                  e.stopPropagation();
                  handleRemove(doc);
                }}
                disabled={disabled}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* File count indicator */}
      {documents.length > 0 && (
        <p className="text-xs text-zinc-500 text-right">
          {documents.filter((d) => d.status === "uploaded").length} of {maxFiles}{" "}
          files uploaded
        </p>
      )}
    </div>
  );
}
