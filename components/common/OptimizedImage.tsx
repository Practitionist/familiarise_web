"use client";

import React from "react";
import Image, { ImageProps } from "next/image";

interface OptimizedImageProps extends Omit<ImageProps, "src"> {
  src: string;
  fallbackSrc?: string;
  alt: string;
  className?: string;
}

/**
 * OptimizedImage component that automatically uses WebP and AVIF formats when available
 * Falls back to original image format if modern formats aren't available
 */
export default function OptimizedImage({
  src,
  fallbackSrc,
  alt,
  className = "",
  ...props
}: OptimizedImageProps) {
  // Extract the path and filename without extension
  const getOptimizedSrc = (format: string): string => {
    if (!src || typeof src !== "string") return "";

    const srcPath = src.startsWith("/") ? src : `/${src}`;
    const lastDotIndex = srcPath.lastIndexOf(".");

    if (lastDotIndex === -1) return srcPath;

    const pathWithoutExt = srcPath.substring(0, lastDotIndex);
    const directory = pathWithoutExt.substring(
      0,
      pathWithoutExt.lastIndexOf("/"),
    );
    const filename = pathWithoutExt.substring(
      pathWithoutExt.lastIndexOf("/") + 1,
    );

    return `/${format}${directory}/${filename}.${format}`;
  };

  const avifSrc = getOptimizedSrc("avif");
  const webpSrc = getOptimizedSrc("webp");
  const originalSrc = fallbackSrc || src;

  return (
    <picture>
      {avifSrc && <source srcSet={avifSrc} type="image/avif" />}
      {webpSrc && <source srcSet={webpSrc} type="image/webp" />}
      <Image src={originalSrc} alt={alt} className={className} {...props} />
    </picture>
  );
}
