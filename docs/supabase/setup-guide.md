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

## Postgres queue libraries through the Supabase pooler

This section records what was measured on 2026-10-31 when two Postgres-backed queue libraries were run against the Mumbai poolers, in throwaway `lab_` schemas that were dropped afterwards. Nothing here is installed in the app. The method and the full results are in [Background-job runtime options](../maintenance/14-background-job-runtime-options.md). Per-statement latency to these poolers was measured at 62–64 ms from Netlify Singapore with raw `pg` (about 95 ms measured earlier through the app; Prisma's own overhead is below noise) and 1.0–2.1 ms from a Vercel `bom1` function. Supabase's own guide says transaction mode on port 6543 is for serverless and edge functions and does not support prepared statements ([Connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres)).

- **Both libraries install and run on both poolers.** pg-boss 12.38.0 and DBOS Transact 5.4.0 migrated their own tables and processed jobs through the transaction pooler (port 6543) and the session pooler (port 5432). Enqueueing inside the caller's transaction was correct on both: a rollback left no job.
- **DBOS needs a pool of about 10.** With `systemDatabasePoolSize: 2` its advisory-lock connection, which has a 5-second idle-in-transaction timeout, was starved and Postgres killed it. The default pool of 10 was stable. The minimum between 2 and 10 was not measured. This is incompatible with `PG_POOL_MAX=1` on Netlify.
- **LISTEN/NOTIFY needs the session pooler.** DBOS's check failed on 6543 and it fell back to polling; it worked on 5432. A transaction pooler cannot carry LISTEN.
- **pg-boss can fire one extra cron job** about 30 seconds after the first, in the first minute after `schedule()`. It happened in 2 of 2 runs on both poolers and settled to once a minute. Keep handlers idempotent.
- **A library that owns its schema sits outside `prisma/schema.prisma`.** The schema-freeze and sidecar rules in `AGENTS.md` section 2.3 apply: adopting one needs an owner decision first.

---

**Need Help?** Check the browser console for detailed error messages, or contact support with the specific error code and message you're seeing.
