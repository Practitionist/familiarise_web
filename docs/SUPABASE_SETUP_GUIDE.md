# Supabase Storage Setup Guide

## Quick Fix for "Bucket not found" Error

If you're getting a "bucket not found" error when uploading documents, you need to create the storage bucket. Here are two ways to fix this:

## Option 1: Manual Bucket Creation (Recommended for Quick Start)

1. **Go to your Supabase Dashboard**
   - Visit: https://supabase.com/dashboard
   - Select your project

2. **Navigate to Storage**
   - In the left sidebar, click **Storage**
   - Click **Buckets**

3. **Create the Documents Bucket**
   - Click **"Create Bucket"**
   - Set bucket name: `documents`
   - **Important**: Enable **"Public bucket"** option
   - Click **"Create bucket"**

4. **Configure Bucket Policies (if needed)**
   - The bucket policies should be automatically configured for public access
   - If you have issues, you can add custom policies later

## Option 2: Automatic Bucket Creation (For Production)

1. **Get your Service Role Key**
   - In Supabase Dashboard: **Settings** → **API**
   - Copy the **service_role** key (not the anon key)

2. **Add Environment Variable**
   ```bash
   # Add this to your .env.local file
   SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
   ```

3. **Restart your development server**
   ```bash
   npm run dev
   ```

## Environment Variables Checklist

Make sure you have these environment variables set:

```bash
# Required
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key

# Optional (for automatic bucket creation)
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

## Testing the Setup

After creating the bucket, try uploading a document again. You should see:
- ✅ Successful upload
- ✅ Document appears in the documents list
- ✅ File is stored in Supabase Storage under `documents/appointments/{appointmentId}/consultee-{consulteeId}/`

## Troubleshooting

### Still getting errors?

1. **Check bucket name**: Must be exactly `documents` (lowercase)
2. **Check public access**: Bucket must be public
3. **Check file size**: Max 10MB per file
4. **Check file type**: Only PDF, Word docs, images, and text files
5. **Check console logs**: Look for detailed error messages

### Verify Bucket Creation

1. Go to **Storage** → **Buckets** in Supabase Dashboard
2. You should see a `documents` bucket
3. The bucket should show as "Public"

## File Storage Structure

Once working, your files will be organized like this:

```
documents/
├── appointments/
│   ├── appointment-id-1/
│   │   ├── consultee-user-1/
│   │   │   ├── 1704067200000_resume.pdf
│   │   │   └── 1704067201000_cover_letter.docx
│   │   └── consultee-user-2/
│   │       └── 1704067300000_portfolio.pdf
│   └── appointment-id-2/
└── ...
```

## Security Notes

- The `documents` bucket is public for file access
- Access control is handled at the application level (consultees can only upload to their appointments, consultants can only review their appointments)
- Files are organized by appointment and user to prevent unauthorized access
- File types and sizes are validated both client-side and server-side

---

**Need Help?** Check the browser console for detailed error messages, or contact support with the specific error code and message you're seeing.