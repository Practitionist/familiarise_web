# Document Review System

A comprehensive document review feature that allows consultees to upload documents for expert review and consultants to provide feedback.

## 🌟 Features

### 📤 For Consultees

- **Upload Documents**: Support for PDF, Word documents, images, and text files (up to 10MB)
- **Document Management**: View, download, and delete pending documents
- **Real-time Status**: Track review status (Pending, In Review, Approved, Rejected, Needs Revision)
- **Review Feedback**: Receive detailed notes and feedback from consultants
- **Context-Aware Interface**: Smart UI that only shows document upload for appropriate appointment types

### 📋 For Consultants

- **Review Dashboard**: Centralized view of all documents requiring review
- **Filtering Options**: Filter by status, appointment type, and client
- **Review Tools**: Update status, add detailed review notes
- **Client Context**: See client information and appointment details for each document
- **Bulk Operations**: Efficiently review multiple documents

### 🛡️ Enhanced Error Handling & User Experience

The system now includes comprehensive error handling that provides user-friendly messages and graceful degradation:

#### 🔍 Error Categories

**Authentication Errors**

- Clear messages when user needs to sign in
- Automatic redirect to sign-in page when appropriate
- Session expiration handling

**Permission Errors**

- Specific messages about access levels (consultee vs consultant)
- Helpful guidance on what the user can and cannot do

**Network Errors**

- Connection failure detection
- Offline state handling
- Retry mechanisms with exponential backoff

**Storage Errors**

- File upload failures with specific causes
- Storage quota and size limit violations
- Temporary storage unavailability

**Data Corruption/Missing Data**

- Graceful handling of missing or corrupt documents
- Empty folder states with helpful guidance
- Database inconsistency recovery

#### 📱 User-Friendly Error Messages

Instead of generic "Error 404" messages, users now see:

**Before**: `"Failed to fetch documents: Not Found"`
**After**:

```
🔍 Appointment not found
This appointment doesn't exist or you don't have permission to view it.
Please check the appointment details or contact support if you believe this is an error.

[Try Again] [Contact Support]
```

**Before**: `"Upload failed"`
**After**:

```
📁 File too large
The selected file is 15MB. Please select a file smaller than 10MB.

Supported formats: PDF, Word documents, images (JPG, PNG, GIF), text files

[Choose Different File]
```

#### 🛠️ Error Recovery Features

**Smart Retry Logic**

- Network errors: Automatic retry with exponential backoff
- Temporary failures: Smart retry suggestions
- Permanent failures: Clear next steps

**Context-Aware Help**

- Connection troubleshooting tips for network issues
- File format guidance for upload errors
- Permission clarification for access errors

**Graceful Degradation**

- Empty states with helpful onboarding
- Partial data loading when possible
- Offline-friendly error messages

#### 🔧 Error Handling Implementation

**API Layer Error Codes**

```typescript
// Standardized error response format
{
  error: "User-friendly title",
  message: "Detailed explanation with next steps",
  code: "SPECIFIC_ERROR_CODE", // For programmatic handling
}
```

**Frontend Error Handling**

```typescript
// Enhanced error detection and user guidance
switch (errorData.code) {
  case 'FILE_TOO_LARGE':
    showFileSize Guidance();
    break;
  case 'NETWORK_ERROR':
    showConnectionTips();
    enableRetryMode();
    break;
  case 'ACCESS_DENIED':
    showPermissionGuidance();
    break;
}
```

**Error Recovery UI Components**

- Retry buttons with loading states
- Contextual help sections
- Progressive disclosure of technical details (dev mode)
- Smart action suggestions based on error type

#### 📊 Error Monitoring

**Development Mode**

- Detailed technical error information
- Stack traces and debugging context
- API response inspection tools

**Production Mode**

- User-friendly messages only
- Automatic error reporting
- Performance impact tracking

## 🏗️ Architecture

### Database Schema

#### AppointmentDocument Model

```prisma
model AppointmentDocument {
  id           String  @id @default(uuid())
  fileName     String
  originalName String
  fileSize     Int
  mimeType     String
  fileUrl      String
  storagePath  String
  description  String?

  // Review fields
  reviewStatus   DocumentReviewStatus @default(PENDING)
  reviewNotes    String?
  reviewedAt     DateTime?
  reviewedBy     String?

  // Relations
  appointment   Appointment @relation(fields: [appointmentId], references: [id])
  appointmentId String

  // Metadata
  uploadedAt DateTime @default(now())
  updatedAt  DateTime @updatedAt

  @@index([appointmentId])
  @@index([reviewStatus])
}

enum DocumentReviewStatus {
  PENDING
  IN_REVIEW
  APPROVED
  REJECTED
  NEEDS_REVISION
}
```

### File Storage Structure

```
supabase-bucket: documents/
├── appointments/
│   └── {appointmentId}/
│       └── consultee-{consulteeId}/
│           ├── resume_2024.pdf
│           ├── tax_return.pdf
│           └── legal_document.docx
```

### API Endpoints

#### Document Management

- `GET /api/appointments/{appointmentId}/documents` - List documents
- `POST /api/appointments/{appointmentId}/documents` - Upload document
- `GET /api/appointments/{appointmentId}/documents/{documentId}` - Get document details
- `PATCH /api/appointments/{appointmentId}/documents/{documentId}` - Update review status
- `DELETE /api/appointments/{appointmentId}/documents/{documentId}` - Delete document

#### Consultant Dashboard

- `GET /api/dashboard/consultant/{consultantId}/documents` - List all documents for review

### Error Handling Specifications

#### API Error Response Format

```typescript
interface ApiError {
  error: string; // User-friendly title
  message: string; // Detailed explanation
  code?: string; // Programmatic error code
  timestamp?: string; // When the error occurred
}
```

#### Error Codes Reference

- `UNAUTHORIZED` - User needs to sign in
- `ACCESS_DENIED` - User lacks necessary permissions
- `NOT_FOUND` - Resource doesn't exist or user can't access it
- `INVALID_INPUT` - Request data is malformed or missing
- `FILE_TOO_LARGE` - File exceeds size limits
- `UNSUPPORTED_FILE_TYPE` - File type not allowed
- `NETWORK_ERROR` - Connection or network issues
- `STORAGE_ERROR` - File storage system issues
- `DATABASE_ERROR` - Database temporarily unavailable
- `UNKNOWN_ERROR` - Unexpected system error

## 🚀 Setup Instructions

### 1. Supabase Configuration

Create a "documents" bucket in your Supabase dashboard:

```sql
-- Enable RLS for security
CREATE POLICY "Documents access policy" ON storage.objects
FOR SELECT USING (bucket_id = 'documents' AND auth.uid()::text = (storage.foldername(name))[1]);
```

### 2. Environment Variables

```bash
# Required for file storage
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key # For GitHub Actions
```

### 3. Database Migration

```bash
npx prisma generate
npx prisma db push
```

## 🧹 Maintenance Scripts

### Manual Cleanup

Run the cleanup script manually:

```bash
# Using npm script (recommended)
npm run scripts:cleanup-empty-folders

# Using tsx for development
npm run scripts:cleanup-empty-folders:dev
```

### Automated Cleanup

The GitHub Action runs daily and can also be triggered manually:

1. Go to GitHub Actions tab
2. Select "Cleanup Empty Folders" workflow
3. Click "Run workflow"

## 🔒 Security Features

### Access Control

- **Consultees**: Can only upload/delete documents for their own appointments
- **Consultants**: Can only review documents for their own consultation/subscription plans
- **Document Isolation**: Each appointment's documents are stored in separate folders
- **File Type Validation**: Only allowed file types can be uploaded (PDF, Word, Images, Text)
- **Size Limits**: Maximum 10MB per file to prevent abuse

### Storage Security

- **Signed URLs**: All file access uses temporary, signed URLs
- **Folder Structure**: Organized by appointment and user to prevent cross-access
- **Automatic Cleanup**: Empty folders are cleaned up daily to maintain organization

## 🎨 UI Components

### DocumentUpload Component (Consultee)

- Modal dialog with file upload interface
- Real-time validation and preview
- Document list with status indicators
- Download and delete functionality
- Enhanced error states and recovery

### DocumentsTab Component (Consultant)

- Table view with sorting and filtering
- Inline review status updates
- Bulk operations support
- Client and appointment context
- Comprehensive error handling

## 📱 Responsive Design

The document system is fully responsive across all device sizes:

- **Mobile**: Touch-optimized interface with stacked layouts
- **Tablet**: Balanced grid layouts for optimal space usage
- **Desktop**: Full-featured interface with advanced controls

## 🐛 Troubleshooting

### Debug Commands

```bash
# Check if documents exist in storage
npm run scripts:cleanup-empty-folders:dev

# Verify database schema
npx prisma studio

# Test API endpoints
curl -X GET /api/appointments/{appointmentId}/documents
```

### Common Issues

**Error: "Documents bucket not found"**

- Solution: Create "documents" bucket in Supabase dashboard

**Error: "Permission denied"**

- Solution: Check RLS policies and user authentication

**Error: "Upload fails silently"**

- Solution: Verify SUPABASE_SERVICE_ROLE_KEY is set correctly

**Error: "Cannot load documents"**

- Check network connection
- Verify API endpoints are accessible
- Check browser console for detailed errors

### Error Recovery Procedures

**For Users:**

1. Check internet connection
2. Refresh the page
3. Try uploading a different file format
4. Contact support if issues persist

**For Developers:**

1. Check API logs for specific error codes
2. Verify database connections
3. Test file storage permissions
4. Monitor Supabase dashboard for quotas

**For System Administrators:**

1. Monitor error rates in application logs
2. Check Supabase storage quotas
3. Verify GitHub Actions are running
4. Review and update RLS policies as needed

## 🚀 Future Enhancements

### Planned Features

- **Document Versioning**: Track multiple versions of the same document
- **Collaborative Review**: Multiple consultants reviewing the same document
- **Document Templates**: Pre-built templates for common document types
- **Advanced Search**: Full-text search within documents
- **Notifications**: Email/push notifications for status changes

### Potential Improvements

- **Real-time Status Updates**: WebSocket-based live updates
- **Document Preview**: In-browser preview for PDFs and images
- **Batch Upload**: Upload multiple documents at once
- **Advanced Analytics**: Document review metrics and insights
- **Integration APIs**: Connect with external document management systems

---

_For support or questions about the document review system, please contact the development team or create an issue in the project repository._
