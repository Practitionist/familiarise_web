import Image from "next/image";
import { ImageType } from "@/hooks/useImages";

type ImagePriority = "high" | "low" | "auto";

export function renderImage(
  images: ImageType[],
  index: number,
  fallback: string,
  width: number,
  height: number,
  priority: ImagePriority = "auto",
  sizes?: string,
) {
  const image = images[index];
  const src = image ? image.url : fallback;
  const alt = image ? image.name : "Placeholder image";

  return (
    <Image
      src={src}
      alt={alt}
      width={width}
      height={height}
      priority={priority === "high"}
      loading={priority === "low" ? "lazy" : undefined}
      sizes={sizes || `(max-width: 768px) 100vw, ${width}px`}
      style={{
        width: "100%",
        height: "auto",
        aspectRatio: `${width} / ${height}`,
      }}
      placeholder="blur"
      blurDataURL="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAEtAJJXIDTjwAAAABJRU5ErkJggg=="
    />
  );
}

// Helper function for optimizing hero/LCP images
export function renderLCPImage(
  images: ImageType[],
  index: number,
  fallback: string,
  width: number,
  height: number,
) {
  return renderImage(images, index, fallback, width, height, "high");
}

// Helper function for optimizing below-the-fold images
export function renderLazyImage(
  images: ImageType[],
  index: number,
  fallback: string,
  width: number,
  height: number,
) {
  return renderImage(images, index, fallback, width, height, "low");
}
