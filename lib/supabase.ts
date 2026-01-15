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
 * Ensure a storage bucket exists, create it if it doesn't
 */
const ensureBucketExists = async (bucketName: string): Promise<boolean> => {
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
          public: true,
          allowedMimeTypes: [
            "application/pdf",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "image/jpeg",
            "image/png",
            "image/gif",
            "text/plain",
          ],
          fileSizeLimit: 10485760, // 10MB
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
 * Ensure a folder exists in storage by creating a placeholder file if needed
 * Note: Supabase doesn't have "folders" per se, but we can simulate them with file paths
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
    const bucketReady = await ensureBucketExists("documents");
    if (!bucketReady) {
      return {
        success: false,
        error:
          "Document storage bucket not found. Please create a 'documents' bucket in your Supabase dashboard with public access enabled, or add SUPABASE_SERVICE_ROLE_KEY to your environment variables for automatic bucket creation.",
      };
    }

    // Generate unique filename
    const timestamp = Date.now();
    const _fileExt = file.name.split(".").pop();
    const safeFileName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_");
    const fileName = `${timestamp}_${safeFileName}`;

    // Create folder structure: appointments/{appointmentId}/consultee-{consulteeId}/
    const folderPath = `appointments/${appointmentId}/consultee-${consulteeId}`;
    const storagePath = `${folderPath}/${fileName}`;

    // Ensure folder structure exists (this is mostly for clarity - Supabase creates folders on upload)
    await ensureFolderExists("documents", folderPath);

    // Upload file to Supabase storage
    const { data: _uploadData, error: uploadError } = await supabase.storage
      .from("documents")
      .upload(storagePath, file, {
        cacheControl: "3600",
        upsert: false,
      });

    if (uploadError) {
      console.error("Supabase upload error:", uploadError);
      return { success: false, error: uploadError.message };
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from("documents")
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

export interface PlanMaterialUploadOptions {
  planType: PlanType;
  planId: string;
  file: File;
  description?: string;
}

// Consultant document upload types (for response documents)
export interface ConsultantDocumentUploadOptions {
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
  options: PlanMaterialUploadOptions
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
    const bucketReady = await ensureBucketExists("documents");
    if (!bucketReady) {
      return {
        success: false,
        error:
          "Document storage bucket not found. Please create a 'documents' bucket in your Supabase dashboard.",
      };
    }

    // Generate unique filename
    const timestamp = Date.now();
    const safeFileName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_");
    const fileName = `${timestamp}_${safeFileName}`;

    // Create folder structure: plans/{planType}-plans/{planId}/
    const folderPath = `plans/${planType}-plans/${planId}`;
    const storagePath = `${folderPath}/${fileName}`;

    // Ensure folder structure exists
    await ensureFolderExists("documents", folderPath);

    // Upload file to Supabase storage
    const { error: uploadError } = await supabase.storage
      .from("documents")
      .upload(storagePath, file, {
        cacheControl: "3600",
        upsert: false,
      });

    if (uploadError) {
      console.error("Supabase upload error:", uploadError);
      return { success: false, error: uploadError.message };
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from("documents")
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
    console.error("Error uploading plan material:", error);
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
  planId: string
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
  options: ConsultantDocumentUploadOptions
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
    const bucketReady = await ensureBucketExists("documents");
    if (!bucketReady) {
      return {
        success: false,
        error:
          "Document storage bucket not found. Please create a 'documents' bucket in your Supabase dashboard.",
      };
    }

    // Generate unique filename
    const timestamp = Date.now();
    const safeFileName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_");
    const fileName = `${timestamp}_${safeFileName}`;

    // Create folder structure: appointments/{appointmentId}/consultant-{consultantId}/
    const folderPath = `appointments/${appointmentId}/consultant-${consultantId}`;
    const storagePath = `${folderPath}/${fileName}`;

    // Ensure folder structure exists
    await ensureFolderExists("documents", folderPath);

    // Upload file to Supabase storage
    const { error: uploadError } = await supabase.storage
      .from("documents")
      .upload(storagePath, file, {
        cacheControl: "3600",
        upsert: false,
      });

    if (uploadError) {
      console.error("Supabase upload error:", uploadError);
      return { success: false, error: uploadError.message };
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from("documents")
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
    console.error("Error uploading consultant document:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Upload failed",
    };
  }
};

// Support ticket attachment types
export interface SupportAttachmentUploadOptions {
  ticketId: string;
  file: File;
}

/**
 * Upload support ticket attachment to Supabase storage
 */
const uploadSupportTicketAttachment = async (
  options: SupportAttachmentUploadOptions
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

    // Generate unique filename
    const timestamp = Date.now();
    const safeFileName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_");
    const fileName = `${timestamp}_${safeFileName}`;

    // Create folder structure: support-tickets/{ticketId}/
    const folderPath = `support-tickets/${ticketId}`;
    const storagePath = `${folderPath}/${fileName}`;

    // Ensure folder structure exists
    await ensureFolderExists("support-attachments", folderPath);

    // Upload file to Supabase storage
    const { data: _uploadData, error: uploadError } = await supabase.storage
      .from("support-attachments")
      .upload(storagePath, file, {
        cacheControl: "3600",
        upsert: false,
      });

    if (uploadError) {
      console.error("Supabase upload error:", uploadError);
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
  storagePath: string
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
  // Utility functions
  ensureBucketExists,
  ensureFolderExists,
  getManualBucketInstructions,
  // Constants
  ALLOWED_DOCUMENT_TYPES,
};
