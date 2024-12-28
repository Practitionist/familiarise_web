import Image from "next/image";
import { ImageType } from "@/hooks/useImages";

export function renderImage(
  images: ImageType[],
  index: number,
  fallback: string,
  width: number,
  height: number,
) {
  const image = images[index];
  return (
    <Image
      src={image ? image.url : fallback}
      alt={image ? image.name : "Placeholder image"}
      width={width}
      height={height}
      layout="responsive"
    />
  );
}
