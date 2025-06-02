import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { FileObject } from "@supabase/storage-js"; // Import FileObject type

// Define types for image transformation and the enhanced file object
export interface TransformOptions {
  width?: number;
  height?: number;
  resize?: 'cover' | 'contain' | 'fill';
  quality?: number;
  // format is not a direct option here; Supabase handles it via accept headers or URL extension
}

export interface SupabaseImageFile extends FileObject {
  url: string; // Original public URL
  transformedUrl: string; // Transformed URL (will be same as url if no transformOptions)
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL is not defined in environment variables.");
}
if (!supabaseKey) {
  throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY is not defined in environment variables.");
}

let supabaseInstance: SupabaseClient;
try {
  supabaseInstance = createClient(supabaseUrl, supabaseKey);
} catch (error) {
  console.error("Error creating Supabase client:", error);
  throw new Error(`Failed to initialize Supabase client: ${error instanceof Error ? error.message : String(error)}`);
}

const supabase: SupabaseClient = supabaseInstance;

const fetchImagesFromSupabaseStorage = async (
  bucket: string,
  path: string,
  transformOptions?: TransformOptions
): Promise<SupabaseImageFile[]> => {
  try {
    const { data: files, error: listError } = await supabase.storage.from(bucket).list(path, {
      limit: 10, // Consider making limit and offset parameters if more flexibility is needed
      offset: 0,
      sortBy: { column: "name", order: "asc" }, // Sorting can be removed if not strictly necessary for minor perf gain
    });

    if (listError) {
      console.error(`Error listing images from Supabase bucket '${bucket}', path '${path}':`, listError);
      return [];
    }

    if (!files || files.length === 0) {
      return [];
    }

    return files.map((file) => {
      const { data: originalUrlData } = supabase.storage
        .from(bucket)
        .getPublicUrl(`${path}/${file.name}`);

      let transformedPublicUrl = originalUrlData.publicUrl; // Default to original

      // Apply transformations if options are provided
      if (transformOptions && Object.keys(transformOptions).length > 0) {
        const { data: tUrlData } = supabase.storage
          .from(bucket)
          .getPublicUrl(`${path}/${file.name}`, { transform: transformOptions });
        transformedPublicUrl = tUrlData.publicUrl;
      }

      return {
        ...file, // Spread the original file properties (id, name, metadata, etc.)
        url: originalUrlData.publicUrl,
        transformedUrl: transformedPublicUrl,
      };
    });
  } catch (error) {
    console.error("Unexpected error in fetchImagesFromSupabaseStorage:", error);
    return [];
  }
};

export default supabase;
export { fetchImagesFromSupabaseStorage };
