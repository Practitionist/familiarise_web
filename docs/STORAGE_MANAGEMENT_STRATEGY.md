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
    BB -->|Download| DD[Access File URL]
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

```typescript
// Automatically creates bucket if it doesn't exist
const ensureBucketExists = async (bucketName: string): Promise<boolean> => {
  // Check existence → Create if missing → Configure permissions
};
```

**Features:**

- **Auto-Detection**: Checks bucket existence before operations
- **Auto-Creation**: Creates bucket with proper configuration if missing
- **Permission Setup**: Configures public access and file type restrictions
- **Size Limits**: Enforces 10MB file size limit

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
    UI->>SB: Access public file URL
    SB->>C: Stream file content
```

## Cleanup Strategy

### 1. Daily Automated Cleanup

**Schedule**: Every day at 9:00 AM IST (3:30 AM UTC)
**Trigger**: GitHub Actions workflow

```yaml
# .github/workflows/cleanup-empty-folders.yml
schedule:
  - cron: "30 3 * * *" # 9 AM IST daily
```

**Process:**

1. **Folder Scanning**: Traverses entire appointment hierarchy
2. **Empty Detection**: Identifies folders with no actual files
3. **Cleanup**: Removes placeholder files and empty markers
4. **Reporting**: Logs summary of cleanup actions

#### Automated Cleanup Process Flow

```mermaid
graph TD
    A[GitHub Actions Trigger<br/>Daily 9:00 AM IST] --> B[Start Cleanup Script]

    B --> C[Initialize Supabase Client]
    C --> D{Documents Bucket Exists?}
    D -->|No| E[No Cleanup Needed]
    D -->|Yes| F[Scan appointments/ folder]

    F --> G[For Each Appointment Folder]
    G --> H[Scan Consultee Subfolders]
    H --> I{Folder Empty?}

    I -->|No| J[Check File Age]
    J --> K{Files > 30 days old?}
    K -->|Yes| L[Mark as Stale<br/>Log for Review]
    K -->|No| M[Folder Has Valid Files]

    I -->|Yes| N{Empty > 7 days?}
    N -->|No| O[Skip - Recently Empty]
    N -->|Yes| P[Remove Placeholder Files]
    P --> Q[Delete .keep, .gitkeep, placeholder]
    Q --> R[Mark Folder as Cleaned]

    R --> S{More Consultee Folders?}
    M --> S
    L --> S
    O --> S

    S -->|Yes| H
    S -->|No| T{Appointment Folder Empty?}

    T -->|Yes| U[Clean Appointment Folder]
    T -->|No| V[Keep Appointment Folder]

    U --> W{More Appointment Folders?}
    V --> W

    W -->|Yes| G
    W -->|No| X[Generate Cleanup Report]

    X --> Y[Log Statistics:<br/>- Folders Checked<br/>- Empty Folders Found<br/>- Folders Cleaned<br/>- Stale Files Detected<br/>- Errors Encountered]

    Y --> Z{Errors > 0?}
    Z -->|Yes| AA[Report Errors<br/>Exit with Error Code]
    Z -->|No| BB[Cleanup Complete<br/>Exit Successfully]

    E --> CC[Log: No Action Needed]

    %% Error Handling
    D --> DD{Connection Error?}
    DD -->|Yes| EE[Log Network Error<br/>Retry Logic]
    EE --> FF{Retry Success?}
    FF -->|No| GG[Exit with Error]
    FF -->|Yes| F

    %% Safety Checks
    P --> HH{Safety Check}
    HH --> II{Has DB Record?}
    II -->|Yes| JJ[Skip - File Still Referenced]
    II -->|No| Q

    style A fill:#e3f2fd
    style BB fill:#c8e6c9
    style AA fill:#ffcdd2
    style GG fill:#ffcdd2
    style L fill:#fff3e0
    style JJ fill:#e8f5e8
```

### 2. Stale Data Management

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

### 3. Cleanup Script Features

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

### 4. Data Integrity Safeguards

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

### 2. Health Checks

```bash
# Manual cleanup execution
npm run scripts:cleanup-empty-folders

# Development cleanup with detailed output
npm run scripts:cleanup-empty-folders:dev
```

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

### 2. Data Protection

- **Public URLs**: Secure public URL generation
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

**2. Empty Folder Accumulation**

```bash
Solution: Daily cleanup script removes empty folders automatically
Manual: Run `npm run scripts:cleanup-empty-folders`
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
