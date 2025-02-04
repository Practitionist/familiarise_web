import { useState, useEffect } from "react";
import { fetchImagesFromSupabaseStorage } from "@/lib/supabase";

export type ImageType = {
  url: string;
  name: string;
  bucket_id: string;
  owner: string;
  id: string;
  updated_at: string;
  created_at: string;
  last_accessed_at: string;
  metadata: Record<string, any>;
};

export function useImages(bucket: string, path: string): ImageType[] {
  const [images, setImages] = useState<ImageType[]>([]);

  useEffect(() => {
    const getImages = async () => {
      try {
        const fetchedImages = await fetchImagesFromSupabaseStorage(bucket, path);
        setImages(fetchedImages);
      } catch (error) {
        console.error("Error fetching images in useImages hook:", error);
        setImages([]);
      }
    };

    getImages();
  }, [bucket, path]);

  return images;
}
