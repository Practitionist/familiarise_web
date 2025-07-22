# Document Review System

This document describes the comprehensive document review system implemented for consultation and subscription appointments. The system allows consultees to upload documents for review and consultants to review and provide feedback.

## 🌟 Features

- **📁 Document Upload**: Consultees can upload various document types (PDF, Word, images, etc.)
- **🔍 Review Workflow**: Complete review process with status tracking
- **🗂️ Organized Storage**: Hierarchical folder structure in Supabase Storage
- **🧹 Automated Cleanup**: Daily cleanup of empty folders via GitHub Actions
- **🔐 Secure Access**: Role-based access control for uploads and reviews
- **📱 Responsive UI**: Modern, intuitive interface for both consultees and consultants

## 📋 System Overview

### Database Schema

The system uses the following key models:

- **`AppointmentDocument`**: Stores document metadata and review information
- **`DocumentReviewStatus`**: Enum for tracking review states
- **Integration with `Appointment`**: Links documents to specific appointments

### Storage Structure

Documents are organized in Supabase Storage with the following hierarchy:

```
documents/
├── appointments/
    ├── {appointment-1-id}/
    │   └── consultee-{consultee-id}/
    │       ├── 1234567890_resume.pdf
    │       └── 1234567891_tax_return.pdf
    └── {appointment-2-id}/
        └── consultee-{consultee-id}/
            └── 1234567892_legal_document.pdf
```

## 🚀 Setup Instructions

### 1. Database Migration

Run the Prisma migration to create the necessary database tables:

```bash
# Generate Prisma client with new models
npx prisma generate

# Push schema changes to database
npx prisma db push
```

### 2. Supabase Storage Setup

1. **Create Storage Bucket**:
   - Go to your Supabase dashboard
   - Navigate to Storage
   - Create a new bucket called `documents`
   - Set appropriate policies (public read for file URLs)

2. **Configure Environment Variables**:
   ```env
   NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
   SUPABASE_SERVICE_ROLE_KEY=your_service_role_key  # For cleanup script
   ```

### 3. GitHub Actions Setup

Add the following secrets to your GitHub repository:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` 
- `SUPABASE_SERVICE_ROLE_KEY`

The cleanup action runs daily at 9:00 AM IST (3:30 AM UTC).

## 📖 Usage Guide

### For Consultees (Document Upload)

1. **Navigate to Appointments**: Go to your consultee dashboard appointments page
2. **Find Confirmed Appointment**: Look for consultations or subscriptions with "Approved" or "Scheduled" status
3. **Upload Documents**: Click the "Upload Documents" button on the appointment card
4. **Select File**: Choose a file (max 10MB, supported types: PDF, Word, images, text)
5. **Add Description**: Optionally describe what the document is (resume, ITR, legal document, etc.)
6. **Track Status**: Monitor review progress with status badges:
   - 🟡 **Pending**: Waiting for consultant review
   - 🔵 **In Review**: Being reviewed by consultant
   - 🟢 **Approved**: Document approved
   - 🔴 **Rejected**: Document rejected with feedback
   - 🟠 **Needs Revision**: Requires changes

### For Consultants (Document Review)

1. **Access Review Dashboard**: Navigate to your consultant dashboard
2. **Go to Documents Tab**: Click on "Documents For Review"
3. **Review Documents**: See all documents from your consultees organized by status
4. **Preview Files**: Click the eye icon to view documents
5. **Update Review Status**: Click "Review" to:
   - Change status (Pending → In Review → Approved/Rejected/Needs Revision)
   - Add review notes and feedback
   - Timestamp the review action

## 🛠️ API Endpoints

### Document Management

- **Upload Document**: `POST /api/appointments/{appointmentId}/documents`
- **List Documents**: `GET /api/appointments/{appointmentId}/documents`
- **Get Document**: `GET /api/appointments/{appointmentId}/documents/{documentId}`
- **Update Review**: `PATCH /api/appointments/{appointmentId}/documents/{documentId}`
- **Delete Document**: `DELETE /api/appointments/{appointmentId}/documents/{documentId}`

### Consultant Dashboard

- **Get All Documents for Review**: `GET /api/dashboard/consultant/{consultantId}/documents`
  - Query params: `status`, `appointmentType`

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

## 🔐 Security Features

- **File Type Validation**: Only allowed file types can be uploaded
- **Size Limits**: Maximum 10MB per file
- **Access Control**: Users can only access their own documents
- **Role-based Permissions**: 
  - Consultees can upload and delete pending documents
  - Consultants can review and update document status
- **Secure Storage**: Files stored in organized, access-controlled folders

## 🎨 UI Components

### DocumentUpload Component

Located in `app/dashboard/consultee/[consulteeId]/(features)/appointments/DocumentUpload.tsx`

Features:
- Drag-and-drop feel file selection
- File type and size validation
- Progress tracking
- Document listing with status
- Delete functionality for pending documents

### DocumentsTab Component

Located in `app/dashboard/consultant/[consultantId]/(features)/documents/DocumentsTab.tsx`

Features:
- Tabular view of all documents
- Status-based color coding
- Preview and download actions
- Review dialog with status updates
- Client information display

## 📱 Responsive Design

The system is fully responsive and works on:
- Desktop browsers
- Tablets
- Mobile devices

## 🔮 Future Enhancements

The system is designed for easy extension:

- **Webinar Documents**: The database structure supports webinar document uploads
- **Class Documents**: Ready for class-based document submissions
- **Advanced File Types**: Easy to add support for new file formats
- **Batch Operations**: Structure supports bulk document operations
- **Version Control**: Framework ready for document versioning

## 🐛 Troubleshooting

### Common Issues

1. **Upload Fails**: Check file size (< 10MB) and type (PDF, Word, images, text)
2. **Access Denied**: Ensure user is properly authenticated and has access to the appointment
3. **Documents Not Loading**: Verify Supabase credentials and bucket permissions
4. **Cleanup Script Fails**: Check GitHub Actions secrets and Supabase service role key

### Debug Commands

```bash
# Check if documents exist in storage
npm run scripts:cleanup-empty-folders:dev

# Verify database schema
npx prisma studio

# Test API endpoints
curl -X GET /api/appointments/{appointmentId}/documents
```

## 📞 Support

For issues or questions about the document review system, please:

1. Check this documentation
2. Review the troubleshooting section
3. Check GitHub Actions logs for cleanup issues
4. Contact the development team

---

*This system provides a solid foundation for document management with room for future enhancements and scaling.* 