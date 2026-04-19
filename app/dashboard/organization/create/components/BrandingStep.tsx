"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Building2, Upload, X } from "lucide-react";
import type { StepProps } from "../types";

export function BrandingStep({
  onNext,
  onBack,
  initialData,
  isSubmitting,
}: StepProps) {
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [bannerFile, setBannerFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(
    initialData.logo ?? null,
  );
  const [bannerPreview, setBannerPreview] = useState<string | null>(
    initialData.bannerImage ?? null,
  );
  const [primaryColor, setPrimaryColor] = useState(
    initialData.primaryColor ?? "#1a1a2e",
  );
  const [secondaryColor, setSecondaryColor] = useState(
    initialData.secondaryColor ?? "#16213e",
  );
  const [error, setError] = useState<string | null>(null);

  const logoRef = useRef<HTMLInputElement>(null);
  const bannerRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (
    file: File | undefined,
    setter: (f: File | null) => void,
    previewSetter: (url: string | null) => void,
  ) => {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setError("Only JPEG, PNG, and WebP images are accepted.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("File must be under 5MB.");
      return;
    }
    setError(null);
    setter(file);
    previewSetter(URL.createObjectURL(file));
  };

  const handleSubmit = async () => {
    const orgId = initialData.orgId;
    let logoUrl = initialData.logo ?? null;
    let bannerUrl = initialData.bannerImage ?? null;

    // Upload files if selected
    if (orgId && (logoFile || bannerFile)) {
      const uploads = [];
      if (logoFile) {
        const fd = new FormData();
        fd.append("file", logoFile);
        fd.append("type", "logo");
        uploads.push(
          fetch(`/api/organizations/${orgId}/images`, {
            method: "POST",
            body: fd,
          })
            .then((r) => r.json())
            .then((r: { url?: string; error?: string }) => {
              if (r.url) logoUrl = r.url;
              else setError(r.error ?? "Logo upload failed");
            }),
        );
      }
      if (bannerFile) {
        const fd = new FormData();
        fd.append("file", bannerFile);
        fd.append("type", "banner");
        uploads.push(
          fetch(`/api/organizations/${orgId}/images`, {
            method: "POST",
            body: fd,
          })
            .then((r) => r.json())
            .then((r: { url?: string; error?: string }) => {
              if (r.url) bannerUrl = r.url;
              else setError(r.error ?? "Banner upload failed");
            }),
        );
      }
      await Promise.all(uploads);
    }

    // PATCH colors if an orgId exists
    if (orgId) {
      await fetch(`/api/organizations/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          primaryColor,
          secondaryColor,
        }),
      });
    }

    onNext({
      logo: logoUrl,
      bannerImage: bannerUrl,
      primaryColor,
      secondaryColor,
    });
  };

  return (
    <div className="space-y-6">
      {/* Logo */}
      <div className="space-y-2">
        <Label>Organization logo</Label>
        <div className="flex items-center gap-4">
          <div className="w-20 h-20 rounded-xl border border-zinc-200 bg-zinc-50 flex items-center justify-center overflow-hidden">
            {logoPreview ? (
              // `logoPreview` can be a blob: URL (client-side createObjectURL)
              // or a remote https URL once the file has been uploaded. Both
              // work with next/image as long as we supply explicit width +
              // height, which we do below. For the blob URL case the
              // optimizer is bypassed automatically.
              <Image
                src={logoPreview}
                alt="Logo preview"
                width={80}
                height={80}
                className="w-full h-full object-cover"
                unoptimized={logoPreview.startsWith("blob:")}
              />
            ) : (
              <Building2 className="w-8 h-8 text-zinc-400" />
            )}
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => logoRef.current?.click()}
            >
              <Upload className="h-4 w-4 mr-1" /> Upload
            </Button>
            {logoPreview && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setLogoFile(null);
                  setLogoPreview(null);
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
          <input
            ref={logoRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) =>
              handleFileSelect(
                e.target.files?.[0],
                setLogoFile,
                setLogoPreview,
              )
            }
          />
        </div>
      </div>

      {/* Banner */}
      <div className="space-y-2">
        <Label>Banner image</Label>
        <div
          className="relative w-full h-32 rounded-lg border border-zinc-200 bg-zinc-50 flex items-center justify-center overflow-hidden cursor-pointer hover:bg-zinc-100 transition-colors"
          onClick={() => bannerRef.current?.click()}
        >
          {bannerPreview ? (
            // Banner container is flexible width + fixed height, so
            // `fill` with `sizes` is the right next/image shape.
            // `relative` was just added to the parent so fill can
            // absolute-position inside it.
            <Image
              src={bannerPreview}
              alt="Banner preview"
              fill
              sizes="(max-width: 768px) 100vw, 512px"
              className="object-cover"
              unoptimized={bannerPreview.startsWith("blob:")}
            />
          ) : (
            <div className="text-center">
              <Upload className="h-6 w-6 mx-auto text-zinc-400 mb-1" />
              <p className="text-xs text-zinc-500">
                Click to upload a banner image
              </p>
            </div>
          )}
        </div>
        {bannerPreview && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setBannerFile(null);
              setBannerPreview(null);
            }}
          >
            <X className="h-4 w-4 mr-1" /> Remove banner
          </Button>
        )}
        <input
          ref={bannerRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) =>
            handleFileSelect(
              e.target.files?.[0],
              setBannerFile,
              setBannerPreview,
            )
          }
        />
      </div>

      {/* Colors */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="primaryColor">Primary color</Label>
          <div className="flex items-center gap-2">
            <input
              id="primaryColor"
              type="color"
              value={primaryColor}
              onChange={(e) => setPrimaryColor(e.target.value)}
              className="w-10 h-10 rounded border border-zinc-200 cursor-pointer"
            />
            <span className="text-sm text-zinc-500 font-mono">
              {primaryColor}
            </span>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="secondaryColor">Secondary color</Label>
          <div className="flex items-center gap-2">
            <input
              id="secondaryColor"
              type="color"
              value={secondaryColor}
              onChange={(e) => setSecondaryColor(e.target.value)}
              className="w-10 h-10 rounded border border-zinc-200 cursor-pointer"
            />
            <span className="text-sm text-zinc-500 font-mono">
              {secondaryColor}
            </span>
          </div>
        </div>
      </div>

      {/* Preview card */}
      <div className="rounded-xl border border-zinc-200 overflow-hidden">
        <div
          className="h-16"
          style={{ backgroundColor: primaryColor }}
        />
        <div className="p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-zinc-100 flex items-center justify-center overflow-hidden shrink-0">
            {logoPreview ? (
              <Image
                src={logoPreview}
                alt=""
                width={40}
                height={40}
                className="w-full h-full object-cover"
                unoptimized={logoPreview.startsWith("blob:")}
              />
            ) : (
              <Building2 className="w-5 h-5 text-zinc-400" />
            )}
          </div>
          <div>
            <p className="font-medium text-sm">
              {initialData.name || "Your Organization"}
            </p>
            <p
              className="text-xs"
              style={{ color: secondaryColor }}
            >
              {initialData.industry || "Industry"} &middot;{" "}
              {initialData.fundingSource || "Personal"}
            </p>
          </div>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex justify-between pt-4">
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onNext({})}
          >
            Skip for now
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting}
          >
            {isSubmitting ? "Uploading…" : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}
