# Storage Management & Cleanup Strategy

## Overview

This document explains our comprehensive approach to managing document storage, including automatic hierarchy creation, stale data cleanup, and maintenance strategies.

## Visual Documentation Index

This document includes comprehensive visual diagrams to illustrate the document system architecture:

### 📊 **Architecture & Flow Diagrams**

1. **[Complete Document Lifecycle Flow](#complete-document-lifecycle-flow)** - Overview of entire system from upload to review
2. **[Visual Storage Organization](#visual-storage-organization)** - Storage hierarchy and folder structure
3. **[Document Upload Sequence Flow](#document-upload-sequence-flow)** - Detailed upload process interactions
4. **[Document Review Sequence Flow](#document-review-sequence-flow)** - Consultant review workflow
5. **[Automated Cleanup Process Flow](#automated-cleanup-process-flow)** - Maintenance and cleanup procedures
6. **[Error Handling & Development Mode Scenarios](#error-handling--development-mode-scenarios)** - Error handling and testing scenarios

### 🎯 **Quick Navigation**

- **For Developers**: See upload/review sequence diagrams for API integration
- **For DevOps**: See cleanup process flow for maintenance understanding
- **For Testing**: See error handling scenarios for development mode features
- **For Architecture**: See storage organization for infrastructure planning

## System Architecture Overview

### Complete Document Lifecycle Flow

```mermaid
graph TD
    A[User Accesses Document System] --> B{User Role?}

    B -->|Consultee| C[Upload Documents]
    B -->|Consultant| D[Review Documents]

    %% Upload Flow
    C --> E[Select File & Description]
    E --> F{File Valid?}
    F -->|No| G[Show Error Message]
    F -->|Yes| H[Check Authentication]
    H --> I{Authorized?}
    I -->|No| J[Authentication Error]
    I -->|Yes| K[Ensure Bucket Exists]
    K --> L{Bucket Ready?}
    L -->|No| M[Create Documents Bucket]
    M --> N[Configure Permissions]
    N --> O[Generate Unique Filename]
    L -->|Yes| O
    O --> P[Create Folder Structure]
    P --> Q["Upload to Supabase<br/>appointments/{appointmentId}/<br/>consultee-{consulteeId}/"]
    Q --> R{Upload Success?}
    R -->|No| S[Upload Error]
    R -->|Yes| T[Save Metadata to Database]
    T --> U{Database Save Success?}
    U -->|No| V[Cleanup Uploaded File]
    V --> W[Database Error]
    U -->|Yes| X[Upload Complete]

    %% Review Flow
    D --> Y[View Document List]
    Y --> Z[Select Document]
    Z --> AA[View Document Details]
    AA --> BB{Action?}
    BB -->|Review| CC[Update Review Status]
    BB -->|Download| DD[Access Signed URL]
    BB -->|Delete| EE{Document Pending?}
    EE -->|No| FF[Cannot Delete]
    EE -->|Yes| GG[Delete from Storage]
    GG --> HH[Delete from Database]
    CC --> II[Add Review Notes]
    II --> JJ[Set Status: APPROVED/REJECTED/NEEDS_REVISION]
    JJ --> KK[Update Database]
    KK --> LL[Notify Consultee]

    %% Error Handling
    G --> MM[Display User-Friendly Error]
    J --> NN[Redirect to Login]
    S --> OO[Retry Upload Option]
    W --> PP[Show Database Error]

    %% Development Mode
    I --> QQ{Development Mode?}
    QQ -->|Yes| RR[Bypass Access Control]
    RR --> K
    QQ -->|No| K

    style A fill:#e1f5fe
    style X fill:#c8e6c9
    style LL fill:#c8e6c9
    style MM fill:#ffcdd2
    style NN fill:#ffcdd2
    style OO fill:#fff3e0
    style PP fill:#ffcdd2
```

## Storage Hierarchy

### Visual Storage Organization

```mermaid
graph TD
    A[Supabase Storage] --> B[documents bucket]

    B --> C[appointments/]
    C --> D[8b8f818e-a787-45e7-b20b-aee65cb750f9/]
    C --> E[another-appointment-uuid/]
    C --> F[...]

    D --> G[consultee-user123/]
    D --> H[consultee-user456/]

    E --> I[consultee-user789/]
    E --> J[consultee-user321/]

    G --> K["1704067200000_resume.pdf<br/>(Original: resume.pdf)"]
    G --> L["1704067201000_tax_return.pdf<br/>(Original: 2023_tax_return.pdf)"]
    G --> M["1704067202000_cover_letter.docx<br/>(Original: cover letter.docx)"]

    H --> N["1704067300000_portfolio.pdf"]
    H --> O["1704067301000_references.pdf"]

    I --> P["1704067400000_transcript.pdf"]
    J --> Q["1704067500000_diploma.jpg"]

    %% Cleanup Process
    R[Daily Cleanup Process] --> S{Scan Each Folder}
    S --> T{Has Files?}
    T -->|No| U[Empty Folder<br/>Remove Placeholders]
    T -->|Yes| V{Files > 30 Days?}
    V -->|Yes| W[Mark as Stale<br/>Log for Review]
    V -->|No| X[Keep Files]

    %% Auto-Creation Process
    Y[File Upload Request] --> Z[Check Bucket Exists]
    Z --> AA{Bucket Missing?}
    AA -->|Yes| BB[Create documents bucket]
    BB --> CC[Set Permissions & Limits]
    CC --> DD[Generate Folder Path]
    AA -->|No| DD
    DD --> EE["appointments/{appointmentId}/<br/>consultee-{consulteeId}/"]
    EE --> FF[Upload File with Timestamp]

    %% File Naming Convention
    GG[Original Filename] --> HH[Sanitize Special Characters]
    HH --> II[Add Timestamp Prefix]
    II --> JJ["timestamp_sanitized_filename.ext"]

    style B fill:#e1f5fe
    style C fill:#f3e5f5
    style D fill:#e8f5e8
    style E fill:#e8f5e8
    style G fill:#fff3e0
    style H fill:#fff3e0
    style I fill:#fff3e0
    style J fill:#fff3e0
    style K fill:#f1f8e9
    style L fill:#f1f8e9
    style M fill:#f1f8e9
    style U fill:#ffcdd2
    style W fill:#fff3e0
    style X fill:#c8e6c9
```

### Folder Structure

```
documents/                                    # Main bucket
├── appointments/                            # Root folder for all appointments
│   ├── {appointmentId}/                    # Individual appointment folder
│   │   ├── consultee-{consulteeId}/        # Consultee-specific folder
│   │   │   ├── {timestamp}_{filename}     # Actual documents
│   │   │   └── ...
│   │   └── consultant-{consultantId}/      # (Future: consultant materials)
│   └── ...
└── temp/                                   # (Future: temporary uploads)
```

### Naming Conventions

- **Appointment Folders**: Use UUID format (e.g., `8b8f818e-a787-45e7-b20b-aee65cb750f9`)
- **Consultee Folders**: Prefixed with `consultee-` followed by consultee profile ID
- **Files**: `{timestamp}_{sanitized_filename}` format for uniqueness and traceability

## On-the-Fly Creation Strategy

### 1. Bucket Management

The `documents` bucket is configured as **private** (`public: false`). All file access requires signed URLs generated via `supabaseAdmin` (service role).

```typescript
// Automatically creates bucket if it doesn't exist
const ensureBucketExists = async (bucketName: string): Promise<boolean> => {
  // Check existence → Create if missing → Configure as private
};
```

**Features:**

- **Auto-Detection**: Checks bucket existence before operations
- **Auto-Creation**: Creates bucket with `public: false` configuration if missing
- **Private by default**: No public URLs; all access via signed URLs
- **Signed URL generation**: Uses `supabaseAdmin.storage.from('documents').createSignedUrl()` with service role
- **Size Limits**: Enforces 10MB file size limit
- **Service role required**: Every storage call (upload, list, signed URL, delete, bucket create and reconcile) runs on the server's service-role client through `adminStorage()` in `lib/supabase-storage-core.ts`. There is no anon storage client. If `SUPABASE_SERVICE_ROLE_KEY` is missing, storage operations fail with an explicit error.
- **Verified deletes**: `removeObjects()` returns `true` only when every requested path is gone afterwards. Storage's batch delete returns only the objects it removed, so a path missing from that answer is checked with `exists()`. Routes answer `502` and keep the row when a delete is not confirmed.

### 2. Folder Creation

```typescript
// Ensures folder structure exists
const ensureFolderExists = async (
  bucketName: string,
  folderPath: string,
): Promise<boolean> => {
  // Supabase creates folders automatically when files are uploaded
  // This function provides explicit checking for validation
};
```

**How it works:**

- **Implicit Creation**: Supabase creates folder structure when first file is uploaded
- **Path Validation**: Ensures the path structure is valid before upload
- **Error Prevention**: Prevents upload failures due to missing folder structure

### 3. Upload Process

#### Document Upload Sequence Flow

```mermaid
sequenceDiagram
    participant U as User (Consultee)
    participant UI as React Component
    participant API as Next.js API
    participant DB as Prisma/Database
    participant SB as Supabase Storage
    participant BG as Background Jobs

    Note over U,BG: Document Upload Process

    U->>UI: Select file and add description
    UI->>UI: Validate file (size, type)

    alt File Invalid
        UI->>U: Show validation error
    else File Valid
        UI->>API: POST /api/appointments/{id}/documents

        API->>API: Authenticate user
        API->>API: Check appointment access

        alt Development Mode
            API->>API: Bypass access control
            Note right of API: [DEV MODE] Allow any user
        end

        API->>SB: Check if documents bucket exists

        alt Bucket Missing
            API->>SB: Create documents bucket
            SB->>API: Bucket created with permissions
        end

        API->>API: Generate unique filename
        API->>SB: Upload file to folder structure
        Note right of SB: appointments/{appointmentId}/<br/>consultee-{consulteeId}/

        alt Upload Success
            SB->>API: Return file URL and metadata
            API->>DB: Save document record

            alt Database Save Success
                DB->>API: Document saved
                API->>UI: Upload successful
                UI->>U: Show success message
            else Database Save Failed
                API->>SB: Delete uploaded file (cleanup)
                API->>UI: Database error
                UI->>U: Show error with retry option
            end
        else Upload Failed
            SB->>API: Upload error
            API->>UI: Upload failed
            UI->>U: Show network/storage error
        end
    end
```

#### Upload Implementation

```typescript
// Complete upload process with hierarchy management
const uploadAppointmentDocument = async (options: DocumentUploadOptions) => {
  1. Validate file (size, type)
  2. Ensure bucket exists
  3. Generate unique filename
  4. Create folder path
  5. Ensure folder structure
  6. Upload file
  7. Return public URL
}
```

## Document Review Process

### Document Review Sequence Flow

```mermaid
sequenceDiagram
    participant C as User (Consultant)
    participant UI as React Component
    participant API as Next.js API
    participant DB as Prisma/Database
    participant SB as Supabase Storage

    Note over C,SB: Document Review Process

    C->>UI: Access consultant dashboard
    UI->>API: GET /api/dashboard/consultant/{id}/documents

    API->>API: Authenticate consultant

    alt Development Mode
        API->>API: Bypass consultant access control
        Note right of API: [DEV MODE] Allow any user
    else Production Mode
        API->>DB: Verify consultant ownership
        alt Not Authorized
            DB->>API: Access denied
            API->>UI: 403 Forbidden
            UI->>C: Show access denied message
        end
    end

    API->>DB: Fetch documents for review
    DB->>API: Return document list with metadata
    API->>UI: Documents with appointment details
    UI->>C: Display document grid/list

    Note over C,SB: Document Review Action

    C->>UI: Click review button
    UI->>C: Show review dialog
    C->>UI: Set status (APPROVED/REJECTED/NEEDS_REVISION)
    C->>UI: Add review notes
    C->>UI: Submit review

    UI->>API: PATCH /api/appointments/{appointmentId}/documents/{docId}
    API->>API: Validate review data
    API->>DB: Update document review status

    alt Update Success
        DB->>API: Review updated
        API->>UI: Success response
        UI->>C: Show success message
        UI->>UI: Refresh document list
    else Update Failed
        DB->>API: Database error
        API->>UI: Error response
        UI->>C: Show error message
    end

    Note over C,SB: Document Download/View

    C->>UI: Click download/view
    UI->>API: Request signed URL
    API->>SB: createSignedUrl() via supabaseAdmin
    SB->>API: Signed URL (time-limited)
    API->>UI: Return signed URL
    UI->>SB: Access file via signed URL
    SB->>C: Stream file content
```

## Server-client operations and private buckets

Every storage write, delete and signing call runs on the server-side client, never the public one, and private buckets are served only through access-checked signed URLs. The rules are these.

- **Deletes are verified.** `removeObjects` in `lib/supabase-storage-core.ts` returns true only when every path is gone afterwards. Storage's batch delete answers with just the objects it removed, so each path missing from that answer is re-checked with an existence call. `deleteAsset`, `deleteAppointmentDocument` and the feature deletes all route through it, and callers act on the boolean: a route whose storage delete may have left the object behind reports once to Sentry and answers an error, and it keeps the database row so the delete can be retried. A delete that cannot be proven is never reported as a success.
- **Rollbacks use the same path.** When a database insert fails after an upload, the object just written is removed with the same helper, so a failed save does not strand a file.
- **Private buckets hand out short-lived signed URLs only.** Support attachments, appointment documents, plan materials and the finance PDFs are never linked by a stored URL. The app route checks the caller's access, signs a URL (60 seconds for support attachments) and redirects with `Cache-Control: private, no-store`. Rows written before a bucket became private may still hold an old stored URL, so readers map the row to the app route rather than rendering the stored value.
- **Public buckets stay public deliberately.** Avatars, organisation logos and landing assets are served from their public endpoint; they hold nothing that needs an access check.
- **Orphans are swept by reconciliation.** `scripts/cleanup/reconcile-document-storage.ts` treats every path referenced by a database row as live and removes unreferenced objects after a grace period, and it aborts on a listing error rather than deleting on partial information.

See [support attachments](../support/08-intake-callbacks-attachments-and-limits.md#attachments) for the worked example.

## Cleanup Strategy

### 1. Orphan Sweep (`reconcile-document-storage`, daily)

The sweep lists each private bucket and compares the object paths with the rows that reference them. An object that no row references is deleted once it is older than the 7-day grace period.

| Bucket                | Referencing rows                                                     |
| --------------------- | -------------------------------------------------------------------- |
| `documents`           | `AppointmentDocument`, `PlanMaterial`, `ProfileVerificationDocument` |
| `support-attachments` | `SupportTicketAttachment`                                            |

The run counts only the objects that Storage confirms it removed. Any shortfall becomes one error per bucket, which marks the run failed so it is reported once.

### 2. Empty Folders

Supabase Storage folders are virtual prefixes, so an empty folder costs nothing and is not swept. The former daily `cleanup-empty-folders` job was removed as cosmetic.

### 3. Stale Data Management

**Definition of Stale Data:**

- **Empty Folders**: Folders with no files for 7+ days
- **Orphaned Files**: Files without corresponding database records
- **Temporary Files**: Failed uploads or incomplete transfers
- **Old Placeholder Files**: `.keep`, `.gitkeep`, `placeholder` files

**Cleanup Criteria:**

```typescript
const STALE_FILE_DAYS = 30; // Files older than 30 days
const MAX_EMPTY_FOLDER_AGE_DAYS = 7; // Empty folders older than 7 days
```

### 4. Cleanup Script Features

```typescript
// Enhanced cleanup with stale file detection
interface CleanupStats {
  foldersChecked: number;
  emptyFoldersFound: number;
  foldersDeleted: number;
  staleFilesFound: number;
  staleFilesDeleted: number;
  errors: string[];
}
```

**Capabilities:**

- **Comprehensive Scanning**: Checks all appointment and consultee folders
- **Smart Detection**: Identifies truly empty vs. temporarily empty folders
- **Safe Deletion**: Only removes placeholder files, not actual documents
- **Error Handling**: Graceful handling of permission or network issues
- **Detailed Reporting**: Comprehensive logs and statistics

### 5. Data Integrity Safeguards

**Database Synchronization:**

- Files are only deleted if no corresponding database record exists
- Database records are checked before any file deletion
- Orphaned database records trigger cleanup of storage files

**Backup Strategy:**

- **Soft Deletion**: Database records marked as deleted before file removal
- **Grace Period**: 7-day grace period before permanent deletion
- **Recovery Options**: Ability to restore recently deleted files

**Safety Checks:**

```typescript
// Never delete files that:
- Are referenced in active appointments
- Have been accessed recently (< 30 days)
- Are in pending review status
- Have successful upload status
```

## Development Mode Enhancements

### Access Control Bypass

```typescript
const isDevelopment = process.env.NODE_ENV === 'development';

// In development mode:
- Allow access to any appointment's documents
- Bypass consultee/consultant access restrictions
- Enable upload/review by any authenticated user
- Log all access control bypasses
```

**Benefits:**

- **Testing Flexibility**: Easy testing across different user roles
- **Data Visibility**: View all documents for debugging
- **Development Speed**: No need to switch between different user accounts
- **Clear Marking**: All responses marked with `[DEV MODE]` for clarity

### Error Handling & Development Mode Scenarios

```mermaid
sequenceDiagram
    participant U as User
    participant UI as Frontend
    participant API as API Routes
    participant DB as Database
    participant SB as Supabase Storage

    Note over U,SB: Error Handling & Development Mode

    rect rgb(255, 245, 245)
        Note over U,SB: Scenario 1: Bucket Not Found Error
        U->>UI: Upload document
        UI->>API: POST document
        API->>SB: Upload to documents bucket
        SB-->>API: Error: Bucket not found
        API->>SB: Call ensureBucketExists()
        SB->>API: Create bucket with config
        API->>SB: Retry upload
        SB->>API: Upload successful
        API->>UI: Success with auto-created bucket
        UI->>U: Document uploaded successfully
    end

    rect rgb(245, 255, 245)
        Note over U,SB: Scenario 2: Development Mode Access
        Note right of API: NODE_ENV=development
        U->>UI: Access any appointment documents
        UI->>API: GET documents (different user's appointment)
        API->>API: Check isDevelopment = true
        API->>API: Bypass access control
        Note right of API: Log: [DEV MODE] Bypassing access control
        API->>DB: Fetch documents (no user restriction)
        DB->>API: Return all documents
        API->>UI: Documents with [DEV MODE] label
        UI->>U: Show documents with dev indicator
    end

    rect rgb(255, 248, 225)
        Note over U,SB: Scenario 3: Database Error with Graceful Handling
        U->>UI: View consultant documents
        UI->>API: GET consultant documents
        API->>DB: Query appointment documents
        DB-->>API: Database connection error
        API->>API: Catch database error
        API->>UI: Return empty data with friendly message
        Note right of API: "The document system is temporarily unavailable"
        UI->>U: Show retry button and helpful message
        U->>UI: Click retry
        UI->>API: Retry request
        API->>DB: Retry query
        DB->>API: Success
        API->>UI: Documents loaded
        UI->>U: Show documents
    end

    rect rgb(248, 225, 255)
        Note over U,SB: Scenario 4: Upload with Cleanup on Database Failure
        U->>UI: Upload large document
        UI->>API: POST document
        API->>SB: Upload to storage
        SB->>API: Upload successful + file URL
        API->>DB: Save document metadata
        DB-->>API: Database save failed
        API->>SB: Delete uploaded file (cleanup)
        SB->>API: File deleted
        API->>UI: Error: "File uploaded but couldn't be saved"
        UI->>U: Show retry option
    end
```

## Monitoring & Maintenance

### 1. Storage Metrics

- **Folder Count**: Track growth of appointment folders
- **File Count**: Monitor total documents uploaded
- **Storage Size**: Track total storage usage
- **Cleanup Efficiency**: Monitor empty folder cleanup success rate

### 3. Error Monitoring

- **Failed Uploads**: Track and investigate upload failures
- **Cleanup Errors**: Monitor cleanup script failures
- **Permission Issues**: Track access control problems
- **Storage Quotas**: Monitor approaching storage limits

## Performance Optimizations

### 1. Upload Optimizations

- **File Validation**: Client-side validation before upload
- **Unique Naming**: Prevents conflicts and overwrites
- **Concurrent Uploads**: Support for multiple file uploads
- **Progress Tracking**: Real-time upload progress feedback

### 2. Cleanup Optimizations

- **Batch Operations**: Process multiple items efficiently
- **Rate Limiting**: Prevent API throttling during cleanup
- **Selective Scanning**: Only scan recently modified folders
- **Parallel Processing**: Handle multiple folders concurrently

### 3. Storage Optimizations

- **CDN Caching**: Cache public URLs for faster access
- **Compression**: Automatic compression for supported file types
- **Deduplication**: Prevent duplicate file storage
- **Archive Strategy**: Move old files to cheaper storage tiers

## Security Considerations

### 1. Access Control

- **Role-Based Access**: Consultees can only upload, consultants can review
- **Appointment Isolation**: Users only access their appointment documents
- **File Type Restrictions**: Only allow safe file types
- **Size Limits**: Prevent storage abuse with file size limits
- **Verification document limits**: Server-side limit of 10 documents per verification. Document submission validates ownership before connecting document IDs to a verification record.

### 2. Data Protection

- **Private Buckets**: The `documents`, `support-attachments`, `recordings` and `org-invoices` buckets are private (`public: false`) and are served only through signed URLs. `support-attachments` is set private on the first upload by `reconcileBucketOptions`. Its API rows expose `/api/support-tickets/{ticketId}/attachments/{id}`, which checks the caller and redirects to a 60-second signed URL. The image and preview buckets (`plan-images`, `profile-images`, `organization-images`, `recordings-previews`) stay public, so their public URLs work without any storage policy.
- **Signed URLs**: All document access uses time-limited signed URLs generated via `supabaseAdmin.storage.from('documents').createSignedUrl()`. The service role key (`SUPABASE_SERVICE_ROLE_KEY`) is required.
- **Download Proxy**: The download API endpoint uses `supabaseAdmin` to generate signed URLs. If the service role key is not configured, the endpoint returns an explicit error rather than silently failing.
- **File Scanning**: Virus scanning for uploaded files (future)
- **Audit Logging**: Track all file operations
- **Encryption**: At-rest encryption through Supabase

### 3. Cleanup Safety

- **Verification Steps**: Multiple checks before deletion
- **Rollback Capability**: Ability to restore accidentally deleted files
- **Audit Trail**: Complete log of all cleanup operations
- **Manual Override**: Ability to exclude specific files/folders from cleanup

## Future Enhancements

### 1. Advanced Cleanup

- **AI-Powered Detection**: Machine learning to identify truly stale data
- **Usage Analytics**: Track file access patterns for better cleanup decisions
- **Predictive Cleanup**: Predict which files will become stale
- **Smart Archival**: Automatically move old files to cheaper storage

### 2. Enhanced Monitoring

- **Real-Time Dashboards**: Visual monitoring of storage health
- **Alerting System**: Notifications for cleanup failures or storage issues
- **Performance Metrics**: Detailed performance tracking and optimization
- **Cost Optimization**: Monitor and optimize storage costs

### 3. Extended Features

- **Version Control**: Track file versions and changes
- **Collaborative Editing**: Support for document collaboration
- **Advanced Search**: Full-text search within documents
- **Integration**: Deeper integration with appointment scheduling system

## Troubleshooting Guide

### Common Issues

**1. "Bucket not found" Error**

```bash
Solution: The system will automatically create the bucket on first upload
Status: Fixed with ensureBucketExists() function
```

**3. Permission Denied**

```bash
Check: SUPABASE_SERVICE_ROLE_KEY environment variable
Verify: Bucket permissions and user roles
Debug: Enable development mode for testing
```

**4. Upload Failures**

```bash
Check: File size (max 10MB), file type (PDF, DOC, images)
Verify: Network connectivity and Supabase service status
Debug: Check browser console for detailed error messages
```

### Recovery Procedures

**1. Restore Deleted Files**

- Check Supabase dashboard for recently deleted files
- Review cleanup script logs for deletion details
- Contact support if files were accidentally deleted

**2. Fix Broken Hierarchy**

- Run cleanup script to reset folder structure
- Re-upload documents if necessary
- Verify database consistency

**3. Handle Cleanup Script Failures**

- Check GitHub Actions logs for detailed error information
- Manually run cleanup script with debug output
- Report issues to development team

This comprehensive strategy ensures reliable, efficient, and secure document storage management while providing robust cleanup and maintenance capabilities.

## Deprecated & Superseded Approaches

- **Deleting through the public client and ignoring the result**: storage deletes could silently remove nothing while the caller reported success. Superseded by the server client and the verified `removeObjects` above; never read a `true` from a delete helper as anything weaker than "the object is gone".
- **Public buckets with stored public URLs for user-uploaded private files**: superseded by private buckets and signed redirects; keep public buckets only for assets that are meant to be world-readable.
