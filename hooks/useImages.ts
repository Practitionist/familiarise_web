import { useState, useEffect } from "react";
import { fetchImagesFromSupabaseStorage, SupabaseImageFile } from "@/lib/supabase"; // SupabaseImageFile already extends FileObject and adds url/transformedUrl

// ImageType will now be an alias for SupabaseImageFile for consistency
// as SupabaseImageFile is what fetchImagesFromSupabaseStorage returns
// and it already includes all necessary fields from FileObject plus url and transformedUrl.
export type ImageType = SupabaseImageFile;

// If you need a type that explicitly lists all fields (though redundant if SupabaseImageFile is well-defined):
// export interface ImageType extends FileObject {
//   url: string;
//   transformedUrl: string;
//   // FileObject provides: id, name, bucketId, owner, created_at, updated_at, last_accessed_at, metadata, etc.
//   // Ensure all properties from your old ImageType are covered by FileObject or added here if custom.
//   // For example, if 'bucket_id' was a custom mapping, you'd handle it during data transformation.
//   // However, Supabase FileObject uses 'bucketId'.
// }

export function useImages(bucket: string, path: string): ImageType[] {
  const [images, setImages] = useState<ImageType[]>([]);

  useEffect(() => {
    const getImages = async () => {
      try {
        // fetchImagesFromSupabaseStorage now returns SupabaseImageFile[] which is compatible with ImageType[]
        const fetchedImages: ImageType[] = await fetchImagesFromSupabaseStorage(
          bucket,
          path,
        );
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
