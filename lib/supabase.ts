import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { FileObject } from "@supabase/storage-js"; // Import FileObject type

// Define types for image transformation and the enhanced file object
export interface TransformOptions {
  width?: number;
  height?: number;
  resize?: "cover" | "contain" | "fill";
  quality?: number;
  // format is not a direct option here; Supabase handles it via accept headers or URL extension
}

export interface SupabaseImageFile extends FileObject {
  url: string; // Original public URL
  transformedUrl: string; // Transformed URL (will be same as url if no transformOptions)
}

// Document upload types
export interface DocumentUploadResult {
  success: boolean;
  fileUrl?: string;
  storagePath?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  error?: string;
}

export interface DocumentUploadOptions {
  appointmentId: string;
  consulteeId: string;
  description?: string;
  file: File;
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL is not defined in environment variables.",
  );
}
if (!supabaseKey) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY is not defined in environment variables.",
  );
}

let supabaseInstance: SupabaseClient;
try {
  supabaseInstance = createClient(supabaseUrl, supabaseKey);
} catch (error) {
  console.error("Error creating Supabase client:", error);
  throw new Error(
    `Failed to initialize Supabase client: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const supabase: SupabaseClient = supabaseInstance;

const fetchImagesFromSupabaseStorage = async (
  bucket: string,
  path: string,
  transformOptions?: TransformOptions,
): Promise<SupabaseImageFile[]> => {
  try {
    const { data: files, error: listError } = await supabase.storage
      .from(bucket)
      .list(path, {
        limit: 10, // Consider making limit and offset parameters if more flexibility is needed
        offset: 0,
        sortBy: { column: "name", order: "asc" }, // Sorting can be removed if not strictly necessary for minor perf gain
      });

    if (listError) {
      console.error(
        `Error listing images from Supabase bucket '${bucket}', path '${path}':`,
        listError,
      );
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
          .getPublicUrl(`${path}/${file.name}`, {
            transform: transformOptions,
          });
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

/**
 * Upload document to Supabase storage with organized folder structure
 * Structure: appointments/{appointmentId}/consultee-{consulteeId}/{filename}
 */
const uploadAppointmentDocument = async (
  options: DocumentUploadOptions,
): Promise<DocumentUploadResult> => {
  try {
    const { appointmentId, consulteeId, file } = options;

    // Validate file
    if (!file) {
      return { success: false, error: "No file provided" };
    }

    // Check file size (max 10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      return { success: false, error: "File size exceeds 10MB limit" };
    }

    // Validate file type (common document types)
    const allowedTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/jpeg',
      'image/png',
      'image/gif',
      'text/plain',
    ];

    if (!allowedTypes.includes(file.type)) {
      return { success: false, error: "File type not supported" };
    }

    // Generate unique filename
    const timestamp = Date.now();
    const fileExt = file.name.split('.').pop();
    const safeFileName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
    const fileName = `${timestamp}_${safeFileName}`;

    // Create folder structure: appointments/{appointmentId}/consultee-{consulteeId}/
    const storagePath = `appointments/${appointmentId}/consultee-${consulteeId}/${fileName}`;

    // Upload file to Supabase storage
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('documents') // Make sure this bucket exists
      .upload(storagePath, file, {
        cacheControl: '3600',
        upsert: false,
      });

    if (uploadError) {
      console.error('Supabase upload error:', uploadError);
      return { success: false, error: uploadError.message };
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from('documents')
      .getPublicUrl(storagePath);

    return {
      success: true,
      fileUrl: urlData.publicUrl,
      storagePath,
      fileName,
      fileSize: file.size,
      mimeType: file.type,
    };
  } catch (error) {
    console.error("Error uploading document:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Upload failed",
    };
  }
};

/**
 * Delete document from Supabase storage
 */
const deleteAppointmentDocument = async (storagePath: string): Promise<boolean> => {
  try {
    const { error } = await supabase.storage
      .from('documents')
      .remove([storagePath]);

    if (error) {
      console.error('Error deleting document:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error("Error deleting document:", error);
    return false;
  }
};

/**
 * List documents in a folder
 */
const listAppointmentDocuments = async (folderPath: string): Promise<FileObject[]> => {
  try {
    const { data: files, error } = await supabase.storage
      .from('documents')
      .list(folderPath, {
        limit: 100,
        offset: 0,
        sortBy: { column: 'created_at', order: 'desc' },
      });

    if (error) {
      console.error('Error listing documents:', error);
      return [];
    }

    return files || [];
  } catch (error) {
    console.error("Error listing documents:", error);
    return [];
  }
};

export default supabase;
export { 
  fetchImagesFromSupabaseStorage, 
  uploadAppointmentDocument, 
  deleteAppointmentDocument, 
  listAppointmentDocuments 
};
