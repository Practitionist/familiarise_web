"use client";

import Image from "next/image";
import { cn } from "@/utils/tailwind";

interface ProfileBannerProps {
  coverImage?: string | null;
  fallbackGradient?: string;
  height?: "sm" | "md" | "lg";
  className?: string;
  children?: React.ReactNode;
}

const HEIGHT_CLASSES = {
  sm: "h-32 md:h-40",
  md: "h-48 md:h-64",
  lg: "h-48 md:h-64 lg:h-80",
};

export function ProfileBanner({
  coverImage,
  fallbackGradient = "from-zinc-200 to-zinc-300 dark:from-zinc-800 dark:to-zinc-900",
  height = "md",
  className,
  children,
}: ProfileBannerProps) {
  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-lg",
        HEIGHT_CLASSES[height],
        className,
      )}
    >
      {coverImage ? (
        <Image
          src={coverImage}
          alt="Profile cover"
          fill
          className="object-cover"
          sizes="(max-width: 768px) 100vw, (max-width: 1200px) 80vw, 1200px"
          priority
        />
      ) : (
        <div
          className={cn("absolute inset-0 bg-gradient-to-r", fallbackGradient)}
        />
      )}

      {/* Overlay gradient for better text visibility if children are present */}
      {children && (
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/20 to-transparent" />
      )}

      {/* Children (e.g., profile info overlay) */}
      {children && (
        <div className="absolute inset-0 flex flex-col justify-end p-4 md:p-6">
          {children}
        </div>
      )}
    </div>
  );
}

export default ProfileBanner;
