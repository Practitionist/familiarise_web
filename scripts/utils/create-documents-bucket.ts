#!/usr/bin/env tsx

/**
 * Create the missing 'documents' bucket in Supabase using TypeScript
 */

// Load environment variables from .env file
import { config } from "dotenv";
config({ path: ".env" });

import { createClient, SupabaseClient } from "@supabase/supabase-js";

interface BucketCreationResult {
  success: boolean;
  error?: string;
  bucketName?: string;
}

async function createDocumentsBucket(): Promise<BucketCreationResult> {
  console.log("🚀 Creating documents bucket in Supabase...");
  console.log("📅 Creation time:", new Date().toISOString());

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.log("❌ Missing required environment variables");
    console.log("- SUPABASE_URL:", supabaseUrl ? "✅ SET" : "❌ MISSING");
    console.log("- SERVICE_KEY:", supabaseServiceKey ? "✅ SET" : "❌ MISSING");
    return { success: false, error: "Missing environment variables" };
  }

  // Use service role key for admin operations
  const supabaseAdmin: SupabaseClient = createClient(
    supabaseUrl,
    supabaseServiceKey,
  );

  try {
    // First check if bucket already exists
    console.log("🔍 Checking if documents bucket already exists...");
    const { data: existingBuckets, error: listError } =
      await supabaseAdmin.storage.listBuckets();

    if (listError) {
      console.log("⚠️  Could not list existing buckets:", listError.message);
    } else {
      const existingBucket = existingBuckets?.find(
        (bucket) => bucket.name === "documents",
      );
      if (existingBucket) {
        console.log("✅ Documents bucket already exists!");
        console.log("🔓 Public:", existingBucket.public);
        console.log("📅 Created:", existingBucket.created_at);
        return { success: true, bucketName: "documents" };
      }
    }

    console.log("📦 Creating documents bucket...");

    const { data, error } = await supabaseAdmin.storage.createBucket(
      "documents",
      {
        public: true,
        allowedMimeTypes: [
          // Documents
          "application/pdf",
          "application/msword",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "application/vnd.ms-excel",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/vnd.ms-powerpoint",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          // Images
          "image/jpeg",
          "image/jpg",
          "image/png",
          "image/gif",
          "image/webp",
          // Text files
          "text/plain",
          "text/csv",
          "text/markdown",
          // Archives
          "application/zip",
          "application/x-rar-compressed",
        ],
        fileSizeLimit: 10485760, // 10MB
      },
    );

    if (error) {
      console.log("❌ Failed to create bucket:", error);
      console.log("\n📖 MANUAL CREATION STEPS:");
      console.log("1. In your Supabase dashboard");
      console.log('2. Click "New bucket" button');
      console.log('3. Name: "documents" (exactly this)');
      console.log('4. ✅ Check "Public bucket"');
      console.log('5. Click "Create bucket"');
      return { success: false, error: error.message };
    }

    console.log("✅ Successfully created documents bucket!");
    console.log("📊 Bucket details:", data);

    // Verify it was created and check configuration
    console.log("\n🔍 Verifying bucket creation and configuration...");
    const { data: buckets, error: verifyError } =
      await supabaseAdmin.storage.listBuckets();

    if (verifyError) {
      console.log("⚠️  Could not verify bucket creation:", verifyError.message);
    } else {
      const documentsBucket = buckets?.find((b) => b.name === "documents");
      if (documentsBucket) {
        console.log("✅ Verification successful - documents bucket exists!");
        console.log("🔓 Public:", documentsBucket.public);
        console.log("📅 Created:", documentsBucket.created_at);
        console.log("🔢 File size limit: 10MB");
        console.log(
          "📁 Allowed file types: PDF, Word, Excel, Images, Text, etc.",
        );
      } else {
        console.log("⚠️  Bucket created but not found in verification");
      }
    }

    // Test bucket access with anon key (like UI does)
    console.log("\n🧪 Testing bucket access with anonymous key...");
    const supabaseAnon = createClient(
      supabaseUrl,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    const { data: _testFiles, error: accessError } = await supabaseAnon.storage
      .from("documents")
      .list("", { limit: 1 });

    if (accessError) {
      console.log("⚠️  Bucket access test failed:", accessError.message);
      console.log("   This might explain why UI uploads fail!");
      console.log("   Check RLS policies and bucket permissions.");
    } else {
      console.log("✅ Bucket access test successful - UI should work now!");
    }

    return { success: true, bucketName: "documents" };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.log("❌ Unexpected error:", errorMessage);
    return { success: false, error: errorMessage };
  }
}

// Run the bucket creation
createDocumentsBucket()
  .then((result) => {
    if (result.success) {
      console.log("\n🎉 Bucket creation completed successfully!");
      process.exit(0);
    } else {
      console.log("\n💥 Bucket creation failed:", result.error);
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error("💥 Script failed:", error);
    process.exit(1);
  });
