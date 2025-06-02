import { useState, useEffect } from "react";
import {
  fetchImagesFromSupabaseStorage,
  SupabaseImageFile,
} from "@/lib/supabase"; // SupabaseImageFile already extends FileObject and adds url/transformedUrl

export function useImages(bucket: string, path: string): SupabaseImageFile[] {
  const [images, setImages] = useState<SupabaseImageFile[]>([]);

  useEffect(() => {
    const getImages = async () => {
      try {
        const fetchedImages: SupabaseImageFile[] =
          await fetchImagesFromSupabaseStorage(bucket, path);
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
