import * as Sentry from "@sentry/nextjs";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { FileObject } from "@supabase/storage-js"; // Import FileObject type

// Define types for image transformation and the enhanced file object
interface TransformOptions {
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
interface DocumentUploadResult {
  success: boolean;
  fileUrl?: string;
  storagePath?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  error?: string;
}

interface DocumentUploadOptions {
  appointmentId: string;
  consulteeId: string;
  description?: string;
  file: File;
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

// Regular client for public operations
let supabaseInstance: SupabaseClient;
try {
  supabaseInstance = createClient(supabaseUrl, supabaseKey);
} catch (error) {
  console.error("Error creating Supabase client:", error);
  throw new Error(
    `Failed to initialize Supabase client: ${error instanceof Error ? error.message : String(error)}`,
  );
}

// Admin client for administrative operations (bucket creation, etc.)
let supabaseAdminInstance: SupabaseClient | null = null;
if (supabaseServiceKey) {
  try {
    supabaseAdminInstance = createClient(supabaseUrl, supabaseServiceKey);
  } catch (error) {
    console.error("Error creating Supabase admin client:", error);
    // Don't throw error here - some operations might work without admin privileges
  }
} else {
  console.warn(
    "⚠️  SUPABASE_SERVICE_ROLE_KEY not found in environment variables",
  );
  console.warn(
    "   Automatic bucket creation will fail - you may need to create buckets manually",
  );
  console.warn(
    "   To fix: Add SUPABASE_SERVICE_ROLE_KEY to your .env.local file",
  );
  console.warn(
    "   Get it from: Supabase Dashboard → Settings → API → service_role key (⚠️  Keep this secret!)",
  );
}

const supabase: SupabaseClient = supabaseInstance;
const supabaseAdmin: SupabaseClient | null = supabaseAdminInstance;

/**
 * Centralized MIME type to file extension map.
 * Used by generateStorageFileName() to derive extensions from MIME types
 * instead of user-controlled file.name values.
 */
export const MIME_TO_EXT: Record<string, string> = {
  // Images
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  // Documents
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
  "application/zip": "zip",
  "application/x-rar-compressed": "rar",
  // Video
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-msvideo": "avi",
  // Fallback
  "application/octet-stream": "bin",
};

/**
 * Generate a UUID-based storage filename with MIME-derived extension.
 * Guarantees uniqueness (UUID v4) and security (extension from MIME, not user input).
 */
export function generateStorageFileName(mimeType: string): string {
  const ext = MIME_TO_EXT[mimeType];
  if (!ext) throw new Error(`Unsupported MIME type: ${mimeType}`);
  return `${globalThis.crypto.randomUUID()}.${ext}`;
}

interface BucketOptions {
  public?: boolean;
  allowedMimeTypes?: string[];
  fileSizeLimit?: number;
}

/**
 * Ensure a storage bucket exists, create it if it doesn't.
 * Pass options to customize bucket settings per use case.
 */
const ensureBucketExists = async (
  bucketName: string,
  options?: BucketOptions,
): Promise<boolean> => {
  try {
    // First check if bucket exists by trying to list files
    const { data: _files, error: listError } = await supabase.storage
      .from(bucketName)
      .list("", { limit: 1 });

    // If no error, bucket exists
    if (!listError) {
      return true;
    }

    // If error is "Bucket not found", create the bucket
    if (
      listError.message.includes("Bucket not found") ||
      listError.message.includes("not found")
    ) {
      console.log(`Creating bucket: ${bucketName}`);

      // Use admin client for bucket creation if available
      const clientToUse = supabaseAdmin || supabase;

      if (!supabaseAdmin) {
        console.warn(
          "Service role key not available - trying with anon key (may fail)",
        );
      }

      const { data: _createData, error: createError } =
        await clientToUse.storage.createBucket(bucketName, {
          public: options?.public ?? true,
          allowedMimeTypes: options?.allowedMimeTypes ?? [
            "application/pdf",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "image/jpeg",
            "image/png",
            "image/gif",
            "text/plain",
          ],
          fileSizeLimit: options?.fileSizeLimit ?? 10485760, // 10MB
        });

      if (createError) {
        console.error(`Failed to create bucket ${bucketName}:`, createError);
        return false;
      }

      console.log(`Successfully created bucket: ${bucketName}`);
      return true;
    }

    // Other errors
    console.error(`Error checking bucket ${bucketName}:`, listError);
    return false;
  } catch (error) {
    console.error(`Unexpected error ensuring bucket ${bucketName}:`, error);
    return false;
  }
};

/**
 * @deprecated Supabase auto-creates folder structure on file upload.
 * This function makes a storage `.list()` call but always returns `true` regardless of the result.
 * All upload functions now skip this call. Kept for backward compatibility with tests.
 */
const ensureFolderExists = async (
  bucketName: string,
  folderPath: string,
): Promise<boolean> => {
  try {
    // Check if folder has any files (which means it exists)
    const { data: _files, error: listError } = await supabase.storage
      .from(bucketName)
      .list(folderPath, { limit: 1 });

    // If we can list without error and there are files, folder "exists"
    if (!listError) {
      return true;
    }

    // If folder doesn't exist, we don't need to create it explicitly
    // Supabase will create the folder structure when we upload the first file
    // So we just return true here
    return true;
  } catch (error) {
    console.error(`Error ensuring folder exists ${folderPath}:`, error);
    return false;
  }
};

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
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "image/jpeg",
      "image/png",
      "image/gif",
      "text/plain",
    ];

    if (!allowedTypes.includes(file.type)) {
      return { success: false, error: "File type not supported" };
    }

    // Ensure the documents bucket exists (create if it doesn't)
    const bucketReady = await ensureBucketExists("documents", { public: false });
    if (!bucketReady) {
      return {
        success: false,
        error:
          "Document storage bucket not found. Please create a 'documents' bucket in your Supabase dashboard (private), or add SUPABASE_SERVICE_ROLE_KEY to your environment variables for automatic bucket creation.",
      };
    }

    // Generate unique filename using UUID + MIME-derived extension
    const fileName = generateStorageFileName(file.type);

    // Create folder structure: appointments/{appointmentId}/consultee-{consulteeId}/
    const folderPath = `appointments/${appointmentId}/consultee-${consulteeId}`;
    const storagePath = `${folderPath}/${fileName}`;

    // Upload file to Supabase storage
    const { data: _uploadData, error: uploadError } = await supabase.storage
      .from("documents")
      .upload(storagePath, file, {
        cacheControl: "3600",
        upsert: false,
      });

    if (uploadError) {
      console.error("Supabase upload error:", uploadError);
      Sentry.captureException(new Error(uploadError.message), { tags: { subsystem: "storage" } });
      return { success: false, error: uploadError.message };
    }

    // Generate a signed URL (1 hour expiry) for private bucket — use admin client
    const signingClient = supabaseAdmin || supabase;
    const { data: signedUrlData, error: signedUrlError } =
      await signingClient.storage
        .from("documents")
        .createSignedUrl(storagePath, 3600);

    if (signedUrlError || !signedUrlData?.signedUrl) {
      console.error("Failed to create signed URL:", signedUrlError);
      Sentry.captureException(signedUrlError instanceof Error ? signedUrlError : new Error("Failed to create signed URL"), { tags: { subsystem: "storage" } });
      return { success: false, error: "Failed to generate document URL" };
    }

    return {
      success: true,
      fileUrl: signedUrlData.signedUrl,
      storagePath,
      fileName,
      fileSize: file.size,
      mimeType: file.type,
    };
  } catch (error) {
    console.error("Error uploading document:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "storage" } });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Upload failed",
    };
  }
};

/**
 * Delete document from Supabase storage
 */
const deleteAppointmentDocument = async (
  storagePath: string,
): Promise<boolean> => {
  try {
    const { error } = await supabase.storage
      .from("documents")
      .remove([storagePath]);

    if (error) {
      console.error("Error deleting document:", error);
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
const listAppointmentDocuments = async (
  folderPath: string,
): Promise<FileObject[]> => {
  try {
    const { data: files, error } = await supabase.storage
      .from("documents")
      .list(folderPath, {
        limit: 100,
        offset: 0,
        sortBy: { column: "created_at", order: "desc" },
      });

    if (error) {
      console.error("Error listing documents:", error);
      return [];
    }

    return files || [];
  } catch (error) {
    console.error("Error listing documents:", error);
    return [];
  }
};

// Plan material upload types
export type PlanType = "consultation" | "subscription" | "webinar" | "class";

interface PlanMaterialUploadOptions {
  planType: PlanType;
  planId: string;
  file: File;
  description?: string;
}

// Consultant document upload types (for response documents)
interface ConsultantDocumentUploadOptions {
  appointmentId: string;
  consultantId: string;
  file: File;
  responseToDocumentId?: string;
  description?: string;
}

// Allowed MIME types for documents (shared across all document uploads)
const ALLOWED_DOCUMENT_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/zip",
  "application/x-rar-compressed",
];

/**
 * Upload plan material to Supabase storage
 * Structure: plans/{planType}-plans/{planId}/{filename}
 */
const uploadPlanMaterial = async (
  options: PlanMaterialUploadOptions,
): Promise<DocumentUploadResult> => {
  try {
    const { planType, planId, file } = options;

    // Validate file
    if (!file) {
      return { success: false, error: "No file provided" };
    }

    // Check file size (max 10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      return { success: false, error: "File size exceeds 10MB limit" };
    }

    // Validate file type
    if (!ALLOWED_DOCUMENT_TYPES.includes(file.type)) {
      return {
        success: false,
        error: `File type '${file.type}' not supported. Allowed types: PDF, Word, Excel, PowerPoint, images, text files, and archives.`,
      };
    }

    // Ensure the documents bucket exists
    const bucketReady = await ensureBucketExists("documents", { public: false });
    if (!bucketReady) {
      return {
        success: false,
        error:
          "Document storage bucket not found. Please create a 'documents' bucket in your Supabase dashboard.",
      };
    }

    // Generate unique filename using UUID + MIME-derived extension
    const fileName = generateStorageFileName(file.type);

    // Create folder structure: plans/{planType}-plans/{planId}/
    const folderPath = `plans/${planType}-plans/${planId}`;
    const storagePath = `${folderPath}/${fileName}`;

    // Upload file to Supabase storage
    const { error: uploadError } = await supabase.storage
      .from("documents")
      .upload(storagePath, file, {
        cacheControl: "3600",
        upsert: false,
      });

    if (uploadError) {
      console.error("Supabase upload error:", uploadError);
      Sentry.captureException(new Error(uploadError.message), { tags: { subsystem: "storage" } });
      return { success: false, error: uploadError.message };
    }

    // Generate a signed URL for private bucket access (1 hour expiry)
    const { data: signedUrlData, error: signedUrlError } =
      await supabase.storage
        .from("documents")
        .createSignedUrl(storagePath, 3600);

    if (signedUrlError || !signedUrlData?.signedUrl) {
      console.error("Failed to create signed URL:", signedUrlError);
      Sentry.captureException(signedUrlError instanceof Error ? signedUrlError : new Error("Failed to create signed URL"), { tags: { subsystem: "storage" } });
      return { success: false, error: "Failed to generate document URL" };
    }

    return {
      success: true,
      fileUrl: signedUrlData.signedUrl,
      storagePath,
      fileName,
      fileSize: file.size,
      mimeType: file.type,
    };
  } catch (error) {
    console.error("Error uploading plan material:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "storage" } });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Upload failed",
    };
  }
};

/**
 * Delete plan material from Supabase storage
 */
const deletePlanMaterial = async (storagePath: string): Promise<boolean> => {
  try {
    const { error } = await supabase.storage
      .from("documents")
      .remove([storagePath]);

    if (error) {
      console.error("Error deleting plan material:", error);
      return false;
    }

    return true;
  } catch (error) {
    console.error("Error deleting plan material:", error);
    return false;
  }
};

/**
 * List plan materials in a folder
 */
const listPlanMaterials = async (
  planType: PlanType,
  planId: string,
): Promise<FileObject[]> => {
  try {
    const folderPath = `plans/${planType}-plans/${planId}`;
    const { data: files, error } = await supabase.storage
      .from("documents")
      .list(folderPath, {
        limit: 100,
        offset: 0,
        sortBy: { column: "created_at", order: "desc" },
      });

    if (error) {
      console.error("Error listing plan materials:", error);
      return [];
    }

    return files || [];
  } catch (error) {
    console.error("Error listing plan materials:", error);
    return [];
  }
};

/**
 * Upload consultant document (response document) to Supabase storage
 * Structure: appointments/{appointmentId}/consultant-{consultantId}/{filename}
 */
const uploadConsultantDocument = async (
  options: ConsultantDocumentUploadOptions,
): Promise<DocumentUploadResult> => {
  try {
    const { appointmentId, consultantId, file } = options;

    // Validate file
    if (!file) {
      return { success: false, error: "No file provided" };
    }

    // Check file size (max 10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      return { success: false, error: "File size exceeds 10MB limit" };
    }

    // Validate file type
    if (!ALLOWED_DOCUMENT_TYPES.includes(file.type)) {
      return {
        success: false,
        error: `File type '${file.type}' not supported. Allowed types: PDF, Word, Excel, PowerPoint, images, text files, and archives.`,
      };
    }

    // Ensure the documents bucket exists
    const bucketReady = await ensureBucketExists("documents", { public: false });
    if (!bucketReady) {
      return {
        success: false,
        error:
          "Document storage bucket not found. Please create a 'documents' bucket in your Supabase dashboard.",
      };
    }

    // Generate unique filename using UUID + MIME-derived extension
    const fileName = generateStorageFileName(file.type);

    // Create folder structure: appointments/{appointmentId}/consultant-{consultantId}/
    const folderPath = `appointments/${appointmentId}/consultant-${consultantId}`;
    const storagePath = `${folderPath}/${fileName}`;

    // Upload file to Supabase storage
    const { error: uploadError } = await supabase.storage
      .from("documents")
      .upload(storagePath, file, {
        cacheControl: "3600",
        upsert: false,
      });

    if (uploadError) {
      console.error("Supabase upload error:", uploadError);
      Sentry.captureException(new Error(uploadError.message), { tags: { subsystem: "storage" } });
      return { success: false, error: uploadError.message };
    }

    // Generate a signed URL for private bucket access (1 hour expiry)
    const { data: signedUrlData, error: signedUrlError } =
      await supabase.storage
        .from("documents")
        .createSignedUrl(storagePath, 3600);

    if (signedUrlError || !signedUrlData?.signedUrl) {
      console.error("Failed to create signed URL:", signedUrlError);
      Sentry.captureException(signedUrlError instanceof Error ? signedUrlError : new Error("Failed to create signed URL"), { tags: { subsystem: "storage" } });
      return { success: false, error: "Failed to generate document URL" };
    }

    return {
      success: true,
      fileUrl: signedUrlData.signedUrl,
      storagePath,
      fileName,
      fileSize: file.size,
      mimeType: file.type,
    };
  } catch (error) {
    console.error("Error uploading consultant document:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "storage" } });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Upload failed",
    };
  }
};

// Support ticket attachment types
interface SupportAttachmentUploadOptions {
  ticketId: string;
  file: File;
}

/**
 * Upload support ticket attachment to Supabase storage
 */
const uploadSupportTicketAttachment = async (
  options: SupportAttachmentUploadOptions,
): Promise<DocumentUploadResult> => {
  try {
    const { ticketId, file } = options;

    // Validate file
    if (!file) {
      return { success: false, error: "No file provided" };
    }

    // Check file size (max 10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      return { success: false, error: "File size exceeds 10MB limit" };
    }

    // Validate file type (common document types + images)
    const allowedTypes = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "text/plain",
    ];

    if (!allowedTypes.includes(file.type)) {
      return { success: false, error: "File type not supported" };
    }

    // Ensure the support-attachments bucket exists
    const bucketReady = await ensureBucketExists("support-attachments");
    if (!bucketReady) {
      return {
        success: false,
        error:
          "Support attachments storage bucket not found. Please create a 'support-attachments' bucket in your Supabase dashboard with public access enabled.",
      };
    }

    // Generate unique filename using UUID + MIME-derived extension
    const fileName = generateStorageFileName(file.type);

    // Create folder structure: support-tickets/{ticketId}/
    const folderPath = `support-tickets/${ticketId}`;
    const storagePath = `${folderPath}/${fileName}`;

    // Upload file to Supabase storage
    const { data: _uploadData, error: uploadError } = await supabase.storage
      .from("support-attachments")
      .upload(storagePath, file, {
        cacheControl: "3600",
        upsert: false,
      });

    if (uploadError) {
      console.error("Supabase upload error:", uploadError);
      Sentry.captureException(new Error(uploadError.message), { tags: { subsystem: "storage" } });
      return { success: false, error: uploadError.message };
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from("support-attachments")
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
    console.error("Error uploading support attachment:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "storage" } });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Upload failed",
    };
  }
};

/**
 * Delete support ticket attachment from Supabase storage
 */
const deleteSupportTicketAttachment = async (
  storagePath: string,
): Promise<boolean> => {
  try {
    const { error } = await supabase.storage
      .from("support-attachments")
      .remove([storagePath]);

    if (error) {
      console.error("Error deleting support attachment:", error);
      return false;
    }

    return true;
  } catch (error) {
    console.error("Error deleting support attachment:", error);
    return false;
  }
};

/**
 * Get manual bucket creation instructions
 */
const getManualBucketInstructions = (bucketName: string): string => {
  return `
To manually create the '${bucketName}' bucket:

1. Go to your Supabase Dashboard: https://supabase.com/dashboard
2. Select your project
3. Navigate to Storage > Buckets
4. Click "Create Bucket"
5. Set bucket name: "${bucketName}"
6. Enable "Public bucket" option
7. Click "Create bucket"

OR

Add SUPABASE_SERVICE_ROLE_KEY environment variable for automatic bucket creation.
You can find this key in: Dashboard > Settings > API > service_role key
`.trim();
};

// Plan image upload types
export type TPlanImageType = "webinar-plans" | "class-plans";

interface IPlanImageUploadOptions {
  planType: TPlanImageType;
  planId: string;
  file: File;
}

const PLAN_IMAGE_MAX_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_PLAN_IMAGE_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
];

/**
 * Upload plan cover image to Supabase storage
 * Structure: plan-images/{planType}/{planId}/cover.{ext}
 */
const uploadPlanImage = async (
  options: IPlanImageUploadOptions,
): Promise<CoverImageUploadResult> => {
  try {
    const { planType, planId, file } = options;

    if (!file) {
      return { success: false, error: "No file provided" };
    }

    if (file.size > PLAN_IMAGE_MAX_SIZE) {
      return { success: false, error: "File size exceeds 5MB limit" };
    }

    if (!ALLOWED_PLAN_IMAGE_TYPES.includes(file.type)) {
      return {
        success: false,
        error: "File type not supported. Please use JPEG, PNG, or WebP.",
      };
    }

    const bucketReady = await ensureBucketExists("plan-images");
    if (!bucketReady) {
      return {
        success: false,
        error:
          "Plan images storage bucket not found. Please create a 'plan-images' bucket in your Supabase dashboard.",
      };
    }

    const fileName = generateStorageFileName(file.type);
    const folderPath = `${planType}/${planId}`;
    const storagePath = `${folderPath}/${fileName}`;

    // Delete any existing cover images for this plan first
    try {
      const { data: existingFiles } = await supabase.storage
        .from("plan-images")
        .list(folderPath);

      if (existingFiles && existingFiles.length > 0) {
        const filesToDelete = existingFiles.map(
          (f) => `${folderPath}/${f.name}`,
        );
        await supabase.storage.from("plan-images").remove(filesToDelete);
      }
    } catch {
      // Ignore errors when cleaning up old files
    }

    const { error: uploadError } = await supabase.storage
      .from("plan-images")
      .upload(storagePath, file, {
        cacheControl: "3600",
        upsert: true,
      });

    if (uploadError) {
      console.error("Supabase plan image upload error:", uploadError);
      Sentry.captureException(new Error(uploadError.message), { tags: { subsystem: "storage" } });
      return { success: false, error: uploadError.message };
    }

    const { data: urlData } = supabase.storage
      .from("plan-images")
      .getPublicUrl(storagePath);

    return {
      success: true,
      fileUrl: urlData.publicUrl,
      storagePath,
    };
  } catch (error) {
    console.error("Error uploading plan image:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "storage" } });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Upload failed",
    };
  }
};

/**
 * Delete plan cover image from Supabase storage
 */
const deletePlanImage = async (
  planType: TPlanImageType,
  planId: string,
): Promise<boolean> => {
  try {
    const folderPath = `${planType}/${planId}`;

    const { data: files, error: listError } = await supabase.storage
      .from("plan-images")
      .list(folderPath);

    if (listError) {
      console.error("Error listing plan images:", listError);
      return false;
    }

    if (!files || files.length === 0) {
      return true; // No files to delete
    }

    const filesToDelete = files.map((f) => `${folderPath}/${f.name}`);
    const { error: deleteError } = await supabase.storage
      .from("plan-images")
      .remove(filesToDelete);

    if (deleteError) {
      console.error("Error deleting plan images:", deleteError);
      return false;
    }

    return true;
  } catch (error) {
    console.error("Error deleting plan image:", error);
    return false;
  }
};

// Cover image upload types
interface CoverImageUploadOptions {
  userId: string;
  file: File;
}

interface CoverImageUploadResult {
  success: boolean;
  fileUrl?: string;
  storagePath?: string;
  error?: string;
}

// Allowed MIME types for cover images
const ALLOWED_COVER_IMAGE_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
];

const COVER_IMAGE_MAX_SIZE = 5 * 1024 * 1024; // 5MB

// Profile display image upload types (square image for Explore Experts page)
interface ProfileDisplayImageUploadOptions {
  userId: string;
  file: File;
}

interface ProfileDisplayImageUploadResult {
  success: boolean;
  fileUrl?: string;
  storagePath?: string;
  error?: string;
}

// Allowed MIME types for profile display images
const ALLOWED_PROFILE_DISPLAY_IMAGE_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
];

const PROFILE_DISPLAY_IMAGE_MAX_SIZE = 2 * 1024 * 1024; // 2MB

/**
 * Upload cover image to Supabase storage
 * Structure: profile-images/covers/{userId}/{filename}
 */
const uploadCoverImage = async (
  options: CoverImageUploadOptions,
): Promise<CoverImageUploadResult> => {
  try {
    const { userId, file } = options;

    // Validate file
    if (!file) {
      return { success: false, error: "No file provided" };
    }

    // Check file size (max 5MB)
    if (file.size > COVER_IMAGE_MAX_SIZE) {
      return { success: false, error: "File size exceeds 5MB limit" };
    }

    // Validate file type
    if (!ALLOWED_COVER_IMAGE_TYPES.includes(file.type)) {
      return {
        success: false,
        error: "File type not supported. Please use JPEG, PNG, or WebP.",
      };
    }

    // Ensure the profile-images bucket exists
    const bucketReady = await ensureBucketExists("profile-images");
    if (!bucketReady) {
      return {
        success: false,
        error:
          "Profile images storage bucket not found. Please create a 'profile-images' bucket in your Supabase dashboard.",
      };
    }

    // Generate unique filename using UUID + MIME-derived extension
    const fileName = generateStorageFileName(file.type);

    // Create folder structure: covers/{userId}/
    const folderPath = `covers/${userId}`;
    const storagePath = `${folderPath}/${fileName}`;

    // Delete any existing cover images for this user first
    try {
      const { data: existingFiles } = await supabase.storage
        .from("profile-images")
        .list(folderPath);

      if (existingFiles && existingFiles.length > 0) {
        const filesToDelete = existingFiles.map(
          (f) => `${folderPath}/${f.name}`,
        );
        await supabase.storage.from("profile-images").remove(filesToDelete);
      }
    } catch {
      // Ignore errors when cleaning up old files
    }

    // Upload file to Supabase storage
    const { error: uploadError } = await supabase.storage
      .from("profile-images")
      .upload(storagePath, file, {
        cacheControl: "3600",
        upsert: true,
      });

    if (uploadError) {
      console.error("Supabase upload error:", uploadError);
      Sentry.captureException(new Error(uploadError.message), { tags: { subsystem: "storage" } });
      return { success: false, error: uploadError.message };
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from("profile-images")
      .getPublicUrl(storagePath);

    return {
      success: true,
      fileUrl: urlData.publicUrl,
      storagePath,
    };
  } catch (error) {
    console.error("Error uploading cover image:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "storage" } });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Upload failed",
    };
  }
};

/**
 * Delete cover image from Supabase storage
 */
const deleteCoverImage = async (userId: string): Promise<boolean> => {
  try {
    const folderPath = `covers/${userId}`;

    // List all files in the user's cover folder
    const { data: files, error: listError } = await supabase.storage
      .from("profile-images")
      .list(folderPath);

    if (listError) {
      console.error("Error listing cover images:", listError);
      return false;
    }

    if (!files || files.length === 0) {
      return true; // No files to delete
    }

    // Delete all files in the folder
    const filesToDelete = files.map((f) => `${folderPath}/${f.name}`);
    const { error: deleteError } = await supabase.storage
      .from("profile-images")
      .remove(filesToDelete);

    if (deleteError) {
      console.error("Error deleting cover images:", deleteError);
      return false;
    }

    return true;
  } catch (error) {
    console.error("Error deleting cover image:", error);
    return false;
  }
};

/**
 * Get cover image URL with optional transformations
 */
const getCoverImageUrl = (
  storagePath: string,
  transformOptions?: TransformOptions,
): string => {
  if (!storagePath) return "";

  const { data } = supabase.storage
    .from("profile-images")
    .getPublicUrl(storagePath, {
      transform: transformOptions,
    });

  return data.publicUrl;
};

/**
 * Upload profile display image to Supabase storage (square image for Explore Experts)
 * Structure: profile-images/display/{userId}/{filename}
 */
const uploadProfileDisplayImage = async (
  options: ProfileDisplayImageUploadOptions,
): Promise<ProfileDisplayImageUploadResult> => {
  try {
    const { userId, file } = options;

    // Validate file
    if (!file) {
      return { success: false, error: "No file provided" };
    }

    // Check file size (max 2MB)
    if (file.size > PROFILE_DISPLAY_IMAGE_MAX_SIZE) {
      return { success: false, error: "File size exceeds 2MB limit" };
    }

    // Validate file type
    if (!ALLOWED_PROFILE_DISPLAY_IMAGE_TYPES.includes(file.type)) {
      return {
        success: false,
        error: "File type not supported. Please use JPEG, PNG, or WebP.",
      };
    }

    // Ensure the profile-images bucket exists
    const bucketReady = await ensureBucketExists("profile-images");
    if (!bucketReady) {
      return {
        success: false,
        error:
          "Profile images storage bucket not found. Please create a 'profile-images' bucket in your Supabase dashboard.",
      };
    }

    // Generate unique filename using UUID + MIME-derived extension
    const fileName = generateStorageFileName(file.type);

    // Create folder structure: display/{userId}/
    const folderPath = `display/${userId}`;
    const storagePath = `${folderPath}/${fileName}`;

    // Delete any existing profile display images for this user first
    try {
      const { data: existingFiles } = await supabase.storage
        .from("profile-images")
        .list(folderPath);

      if (existingFiles && existingFiles.length > 0) {
        const filesToDelete = existingFiles.map(
          (f) => `${folderPath}/${f.name}`,
        );
        await supabase.storage.from("profile-images").remove(filesToDelete);
      }
    } catch {
      // Ignore errors when cleaning up old files
    }

    // Upload file to Supabase storage
    const { error: uploadError } = await supabase.storage
      .from("profile-images")
      .upload(storagePath, file, {
        cacheControl: "3600",
        upsert: true,
      });

    if (uploadError) {
      console.error("Supabase upload error:", uploadError);
      Sentry.captureException(new Error(uploadError.message), { tags: { subsystem: "storage" } });
      return { success: false, error: uploadError.message };
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from("profile-images")
      .getPublicUrl(storagePath);

    return {
      success: true,
      fileUrl: urlData.publicUrl,
      storagePath,
    };
  } catch (error) {
    console.error("Error uploading profile display image:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "storage" } });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Upload failed",
    };
  }
};

/**
 * Delete profile display image from Supabase storage
 */
const deleteProfileDisplayImage = async (userId: string): Promise<boolean> => {
  try {
    const folderPath = `display/${userId}`;

    // List all files in the user's display folder
    const { data: files, error: listError } = await supabase.storage
      .from("profile-images")
      .list(folderPath);

    if (listError) {
      console.error("Error listing profile display images:", listError);
      return false;
    }

    if (!files || files.length === 0) {
      return true; // No files to delete
    }

    // Delete all files in the folder
    const filesToDelete = files.map((f) => `${folderPath}/${f.name}`);
    const { error: deleteError } = await supabase.storage
      .from("profile-images")
      .remove(filesToDelete);

    if (deleteError) {
      console.error("Error deleting profile display images:", deleteError);
      return false;
    }

    return true;
  } catch (error) {
    console.error("Error deleting profile display image:", error);
    return false;
  }
};

// Allowed MIME types and max size for profile avatar images
const ALLOWED_PROFILE_IMAGE_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
];

const PROFILE_IMAGE_MAX_SIZE = 2 * 1024 * 1024; // 2MB

/**
 * Upload profile avatar image to Supabase storage (general avatar for Navbar/session)
 * Structure: profile-images/avatars/{userId}/{filename}
 */
const uploadProfileImage = async (options: {
  userId: string;
  file: File;
}): Promise<{
  success: boolean;
  fileUrl?: string;
  storagePath?: string;
  error?: string;
}> => {
  try {
    const { userId, file } = options;

    if (!file) {
      return { success: false, error: "No file provided" };
    }

    if (file.size > PROFILE_IMAGE_MAX_SIZE) {
      return { success: false, error: "File size exceeds 2MB limit" };
    }

    if (!ALLOWED_PROFILE_IMAGE_TYPES.includes(file.type)) {
      return {
        success: false,
        error: "File type not supported. Please use JPEG, PNG, or WebP.",
      };
    }

    const bucketReady = await ensureBucketExists("profile-images");
    if (!bucketReady) {
      return {
        success: false,
        error:
          "Profile images storage bucket not found. Please create a 'profile-images' bucket in your Supabase dashboard.",
      };
    }

    // Generate unique filename using UUID + MIME-derived extension
    const fileName = generateStorageFileName(file.type);
    const folderPath = `avatars/${userId}`;
    const storagePath = `${folderPath}/${fileName}`;

    // Delete any existing avatar images for this user first
    try {
      const { data: existingFiles } = await supabase.storage
        .from("profile-images")
        .list(folderPath);

      if (existingFiles && existingFiles.length > 0) {
        const filesToDelete = existingFiles.map(
          (f) => `${folderPath}/${f.name}`,
        );
        await supabase.storage.from("profile-images").remove(filesToDelete);
      }
    } catch {
      // Ignore errors when cleaning up old files
    }

    const { error: uploadError } = await supabase.storage
      .from("profile-images")
      .upload(storagePath, file, {
        cacheControl: "3600",
        upsert: true,
      });

    if (uploadError) {
      console.error("Supabase upload error:", uploadError);
      Sentry.captureException(new Error(uploadError.message), { tags: { subsystem: "storage" } });
      return { success: false, error: uploadError.message };
    }

    const { data: urlData } = supabase.storage
      .from("profile-images")
      .getPublicUrl(storagePath);

    return {
      success: true,
      fileUrl: urlData.publicUrl,
      storagePath,
    };
  } catch (error) {
    console.error("Error uploading profile image:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "storage" } });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Upload failed",
    };
  }
};

/**
 * Delete profile avatar image from Supabase storage
 */
const deleteProfileImage = async (userId: string): Promise<boolean> => {
  try {
    const folderPath = `avatars/${userId}`;

    const { data: files, error: listError } = await supabase.storage
      .from("profile-images")
      .list(folderPath);

    if (listError) {
      console.error("Error listing profile images:", listError);
      return false;
    }

    if (!files || files.length === 0) {
      return true;
    }

    const filesToDelete = files.map((f) => `${folderPath}/${f.name}`);
    const { error: deleteError } = await supabase.storage
      .from("profile-images")
      .remove(filesToDelete);

    if (deleteError) {
      console.error("Error deleting profile images:", deleteError);
      return false;
    }

    return true;
  } catch (error) {
    console.error("Error deleting profile image:", error);
    return false;
  }
};

// Organization branding image upload types (logo + banner)
interface OrganizationBrandingUploadOptions {
  organizationId: string;
  file: File;
}

interface OrganizationBrandingUploadResult {
  success: boolean;
  fileUrl?: string;
  storagePath?: string;
  error?: string;
}

// Allowed MIME types for organization branding images.
// SVG is included so brand teams can upload crisp vector logos; JPEG/PNG/WebP
// cover photographic banners.
const ALLOWED_ORG_BRANDING_IMAGE_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/svg+xml",
];

const ORG_LOGO_MAX_SIZE = 2 * 1024 * 1024; // 2MB
const ORG_BANNER_MAX_SIZE = 5 * 1024 * 1024; // 5MB

const ORG_BRANDING_BUCKET = "organization-images";

// generateStorageFileName() relies on MIME_TO_EXT, which doesn't ship with
// SVG by default. Add the local mapping so SVG uploads get a .svg extension.
const ORG_BRANDING_MIME_TO_EXT: Record<string, string> = {
  "image/svg+xml": "svg",
};

const buildOrgBrandingFileName = (mimeType: string): string => {
  const localExt = ORG_BRANDING_MIME_TO_EXT[mimeType];
  if (localExt) {
    return `${globalThis.crypto.randomUUID()}.${localExt}`;
  }
  return generateStorageFileName(mimeType);
};

/**
 * Upload organization logo image to Supabase storage.
 * Structure: organization-images/logos/{organizationId}/{filename}
 */
const uploadOrganizationLogo = async (
  options: OrganizationBrandingUploadOptions,
): Promise<OrganizationBrandingUploadResult> => {
  return uploadOrganizationBrandingImage(options, "logo");
};

/**
 * Upload organization banner image to Supabase storage.
 * Structure: organization-images/banners/{organizationId}/{filename}
 */
const uploadOrganizationBanner = async (
  options: OrganizationBrandingUploadOptions,
): Promise<OrganizationBrandingUploadResult> => {
  return uploadOrganizationBrandingImage(options, "banner");
};

const uploadOrganizationBrandingImage = async (
  options: OrganizationBrandingUploadOptions,
  kind: "logo" | "banner",
): Promise<OrganizationBrandingUploadResult> => {
  try {
    const { organizationId, file } = options;

    if (!file) {
      return { success: false, error: "No file provided" };
    }

    const maxSize =
      kind === "logo" ? ORG_LOGO_MAX_SIZE : ORG_BANNER_MAX_SIZE;
    if (file.size > maxSize) {
      const limitMb = Math.round(maxSize / (1024 * 1024));
      return {
        success: false,
        error: `File size exceeds ${limitMb}MB limit`,
      };
    }

    if (!ALLOWED_ORG_BRANDING_IMAGE_TYPES.includes(file.type)) {
      return {
        success: false,
        error:
          "File type not supported. Please use JPEG, PNG, WebP, or SVG.",
      };
    }

    const bucketReady = await ensureBucketExists(ORG_BRANDING_BUCKET, {
      public: true,
      allowedMimeTypes: ALLOWED_ORG_BRANDING_IMAGE_TYPES,
      fileSizeLimit: ORG_BANNER_MAX_SIZE,
    });
    if (!bucketReady) {
      return {
        success: false,
        error: `Organization images storage bucket not found. Please create an '${ORG_BRANDING_BUCKET}' bucket in your Supabase dashboard.`,
      };
    }

    const folderPath =
      kind === "logo"
        ? `logos/${organizationId}`
        : `banners/${organizationId}`;
    const fileName = buildOrgBrandingFileName(file.type);
    const storagePath = `${folderPath}/${fileName}`;

    // Upsert-single-file pattern: clear out any prior asset so the folder
    // never accumulates orphaned uploads (mirrors uploadProfileImage).
    try {
      const { data: existingFiles } = await supabase.storage
        .from(ORG_BRANDING_BUCKET)
        .list(folderPath);

      if (existingFiles && existingFiles.length > 0) {
        const filesToDelete = existingFiles.map(
          (f) => `${folderPath}/${f.name}`,
        );
        await supabase.storage
          .from(ORG_BRANDING_BUCKET)
          .remove(filesToDelete);
      }
    } catch {
      // Ignore errors when cleaning up old files
    }

    const { error: uploadError } = await supabase.storage
      .from(ORG_BRANDING_BUCKET)
      .upload(storagePath, file, {
        cacheControl: "3600",
        upsert: true,
      });

    if (uploadError) {
      console.error(
        `Supabase organization ${kind} upload error:`,
        uploadError,
      );
      Sentry.captureException(new Error(uploadError.message), { tags: { subsystem: "storage" } });
      return { success: false, error: uploadError.message };
    }

    const { data: urlData } = supabase.storage
      .from(ORG_BRANDING_BUCKET)
      .getPublicUrl(storagePath);

    return {
      success: true,
      fileUrl: urlData.publicUrl,
      storagePath,
    };
  } catch (error) {
    console.error(`Error uploading organization ${kind}:`, error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "storage" } });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Upload failed",
    };
  }
};

/**
 * Delete organization logo image from Supabase storage.
 */
const deleteOrganizationLogo = async (
  organizationId: string,
): Promise<boolean> => {
  return deleteOrganizationBrandingImage(organizationId, "logo");
};

/**
 * Delete organization banner image from Supabase storage.
 */
const deleteOrganizationBanner = async (
  organizationId: string,
): Promise<boolean> => {
  return deleteOrganizationBrandingImage(organizationId, "banner");
};

const deleteOrganizationBrandingImage = async (
  organizationId: string,
  kind: "logo" | "banner",
): Promise<boolean> => {
  try {
    const folderPath =
      kind === "logo"
        ? `logos/${organizationId}`
        : `banners/${organizationId}`;

    const { data: files, error: listError } = await supabase.storage
      .from(ORG_BRANDING_BUCKET)
      .list(folderPath);

    if (listError) {
      console.error(`Error listing organization ${kind} images:`, listError);
      return false;
    }

    if (!files || files.length === 0) {
      return true;
    }

    const filesToDelete = files.map((f) => `${folderPath}/${f.name}`);
    const { error: deleteError } = await supabase.storage
      .from(ORG_BRANDING_BUCKET)
      .remove(filesToDelete);

    if (deleteError) {
      console.error(`Error deleting organization ${kind} images:`, deleteError);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`Error deleting organization ${kind}:`, error);
    return false;
  }
};

/**
 * Generic upload to Supabase storage
 * Returns { url, error } - url is the public URL if successful
 */
const uploadToSupabase = async (
  storagePath: string,
  buffer: Buffer,
  mimeType: string,
  bucketName: string = "documents",
): Promise<{ url: string | null; error: string | null }> => {
  try {
    // Ensure bucket exists — documents bucket is private
    const isPrivateBucket = bucketName === "documents";
    const bucketReady = await ensureBucketExists(
      bucketName,
      isPrivateBucket ? { public: false } : undefined,
    );
    if (!bucketReady) {
      return {
        url: null,
        error: `Bucket '${bucketName}' not found and could not be created`,
      };
    }

    // Upload file
    const { error: uploadError } = await supabase.storage
      .from(bucketName)
      .upload(storagePath, buffer, {
        contentType: mimeType,
        cacheControl: "3600",
        upsert: true,
      });

    if (uploadError) {
      console.error("Supabase upload error:", uploadError);
      Sentry.captureException(new Error(uploadError.message), { tags: { subsystem: "storage" } });
      return { url: null, error: uploadError.message };
    }

    // Private buckets: generate a signed URL via admin client
    // Public buckets: use getPublicUrl for permanent, CDN-friendly links
    if (isPrivateBucket) {
      const signingClient = supabaseAdmin || supabase;
      const { data: signedUrlData, error: signedUrlError } =
        await signingClient.storage
          .from(bucketName)
          .createSignedUrl(storagePath, 3600);

      if (signedUrlError || !signedUrlData?.signedUrl) {
        console.error("Failed to create signed URL:", signedUrlError);
        Sentry.captureException(signedUrlError instanceof Error ? signedUrlError : new Error("Failed to create signed URL"), { tags: { subsystem: "storage" } });
        return { url: null, error: "Failed to generate document URL" };
      }

      return { url: signedUrlData.signedUrl, error: null };
    }

    const { data: urlData } = supabase.storage
      .from(bucketName)
      .getPublicUrl(storagePath);

    return { url: urlData.publicUrl, error: null };
  } catch (error) {
    console.error("Error in uploadToSupabase:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "storage" } });
    return {
      url: null,
      error: error instanceof Error ? error.message : "Upload failed",
    };
  }
};

/**
 * Generic delete from Supabase storage
 */
const deleteFromSupabase = async (
  storagePath: string,
  bucketName: string = "documents",
): Promise<boolean> => {
  try {
    const { error } = await supabase.storage
      .from(bucketName)
      .remove([storagePath]);

    if (error) {
      console.error("Error deleting from Supabase:", error);
      Sentry.captureException(new Error(error.message), { tags: { subsystem: "storage" } });
      return false;
    }

    return true;
  } catch (error) {
    console.error("Error in deleteFromSupabase:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "storage" } });
    return false;
  }
};

export default supabase;
export {
  fetchImagesFromSupabaseStorage,
  uploadAppointmentDocument,
  deleteAppointmentDocument,
  listAppointmentDocuments,
  // Plan materials
  uploadPlanMaterial,
  deletePlanMaterial,
  listPlanMaterials,
  // Consultant documents (response documents)
  uploadConsultantDocument,
  // Support ticket attachments
  uploadSupportTicketAttachment,
  deleteSupportTicketAttachment,
  // Plan images
  uploadPlanImage,
  deletePlanImage,
  ALLOWED_PLAN_IMAGE_TYPES,
  PLAN_IMAGE_MAX_SIZE,
  // Cover image
  uploadCoverImage,
  deleteCoverImage,
  getCoverImageUrl,
  ALLOWED_COVER_IMAGE_TYPES,
  COVER_IMAGE_MAX_SIZE,
  // Profile display image (square image for Explore Experts)
  uploadProfileDisplayImage,
  deleteProfileDisplayImage,
  ALLOWED_PROFILE_DISPLAY_IMAGE_TYPES,
  PROFILE_DISPLAY_IMAGE_MAX_SIZE,
  // Profile avatar image (general avatar for Navbar/session)
  uploadProfileImage,
  deleteProfileImage,
  ALLOWED_PROFILE_IMAGE_TYPES,
  PROFILE_IMAGE_MAX_SIZE,
  // Organization branding (logo + banner)
  uploadOrganizationLogo,
  uploadOrganizationBanner,
  deleteOrganizationLogo,
  deleteOrganizationBanner,
  ALLOWED_ORG_BRANDING_IMAGE_TYPES,
  ORG_LOGO_MAX_SIZE,
  ORG_BANNER_MAX_SIZE,
  // Generic upload/delete
  uploadToSupabase,
  deleteFromSupabase,
  // Utility functions
  ensureBucketExists,
  ensureFolderExists,
  getManualBucketInstructions,
  supabaseAdmin,
  // Constants
  ALLOWED_DOCUMENT_TYPES,
};
