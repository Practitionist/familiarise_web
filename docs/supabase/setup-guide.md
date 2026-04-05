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
   - **Important**: Leave **"Public bucket"** DISABLED (bucket must be private)
   - Click **"Create bucket"**

4. **Configure Service Role Key**
   - Since the bucket is private, all file access requires signed URLs generated via the service role
   - Ensure `SUPABASE_SERVICE_ROLE_KEY` is set in your environment (see below)
   - The application uses `supabaseAdmin` (service role client) for all storage operations

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

# Required for document storage (private bucket operations)
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

**Note**: `SUPABASE_SERVICE_ROLE_KEY` is required (not optional) for document storage. The documents bucket is private, so all file uploads, downloads, and URL generation use `supabaseAdmin` which requires the service role key. If the key is missing, the download proxy will return an explicit error.

## Testing the Setup

After creating the bucket, try uploading a document again. You should see:

- ✅ Successful upload
- ✅ Document appears in the documents list
- ✅ File is stored in Supabase Storage under `documents/appointments/{appointmentId}/consultee-{consulteeId}/`

## Troubleshooting

### Still getting errors?

1. **Check bucket name**: Must be exactly `documents` (lowercase)
2. **Check bucket is private**: Bucket must NOT be public
3. **Check service role key**: `SUPABASE_SERVICE_ROLE_KEY` must be set -- this is required for all private bucket operations
4. **Check file size**: Max 10MB per file
5. **Check file type**: Only PDF, Word docs, images, and text files
6. **Check console logs**: Look for detailed error messages

### Verify Bucket Creation

1. Go to **Storage** → **Buckets** in Supabase Dashboard
2. You should see a `documents` bucket
3. The bucket should show as "Private" (not Public)

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

- The `documents` bucket is **private** (`public: false`). No direct public URL access.
- All file access uses signed URLs generated via `supabaseAdmin` (service role client) with `createSignedUrl()`.
- The download proxy endpoint requires `SUPABASE_SERVICE_ROLE_KEY` and returns an explicit error if the key is missing.
- Access control is handled at the application level (consultees can only upload to their appointments, consultants can only review their appointments)
- Verification document uploads are limited to 10 per verification (server-side enforcement). Document submission validates ownership before connecting document IDs.
- Files are organized by appointment and user to prevent unauthorized access
- File types and sizes are validated both client-side and server-side

---

**Need Help?** Check the browser console for detailed error messages, or contact support with the specific error code and message you're seeing.
