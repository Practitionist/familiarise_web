#!/usr/bin/env tsx

/**
 * Test script to check Supabase bucket existence and creation
 * This script tests the storage functionality using TypeScript
 */

// Load environment variables from .env file
import { config } from "dotenv";
config({ path: ".env" });

import { createClient, SupabaseClient } from "@supabase/supabase-js";

interface BucketTestResult {
  exists: boolean;
  error?: string;
  created?: boolean;
}

async function testBucketCreation(): Promise<void> {
  console.log("🧪 Testing Supabase bucket creation...");
  console.log("📅 Test time:", new Date().toISOString());

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  console.log("\n📋 Environment Check:");
  console.log("- SUPABASE_URL:", supabaseUrl ? "✅ SET" : "❌ MISSING");
  console.log("- ANON_KEY:", supabaseAnonKey ? "✅ SET" : "❌ MISSING");
  console.log("- SERVICE_KEY:", supabaseServiceKey ? "✅ SET" : "❌ MISSING");

  if (!supabaseUrl || !supabaseAnonKey) {
    console.log("❌ Missing required environment variables");
    process.exit(1);
  }

  // Create clients
  const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey);
  const supabaseAdmin: SupabaseClient | null = supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey)
    : null;

  console.log("\n🔍 Testing bucket operations...");

  try {
    // Test 1: Check if documents bucket exists with regular client
    console.log("\n📦 Test 1: Checking documents bucket with ANON key...");
    const anonResult = await testBucketExists(supabase, "documents");
    console.log(
      `   Result: ${anonResult.exists ? "✅ EXISTS" : "❌ NOT FOUND"}`,
    );
    if (anonResult.error) console.log(`   Error: ${anonResult.error}`);

    // Test 2: Check if documents bucket exists with admin client
    if (supabaseAdmin) {
      console.log("\n🔑 Test 2: Checking documents bucket with SERVICE key...");
      const adminResult = await testBucketExists(supabaseAdmin, "documents");
      console.log(
        `   Result: ${adminResult.exists ? "✅ EXISTS" : "❌ NOT FOUND"}`,
      );
      if (adminResult.error) console.log(`   Error: ${adminResult.error}`);
    }

    // Test 3: List all buckets
    console.log("\n📋 Test 3: Listing all buckets...");
    if (supabaseAdmin) {
      const { data: buckets, error: listError } =
        await supabaseAdmin.storage.listBuckets();
      if (listError) {
        console.log(`   Error: ${listError.message}`);
      } else {
        console.log(`   Found ${buckets?.length || 0} buckets:`);
        buckets?.forEach((bucket) => {
          console.log(
            `   - ${bucket.name} (${bucket.public ? "Public" : "Private"})`,
          );
        });
      }
    } else {
      console.log("   ⚠️  Skipped - no service key available");
    }

    // Test 4: Test file upload simulation
    console.log("\n📄 Test 4: Simulating file upload check...");
    const { data: _files, error: uploadTestError } = await supabase.storage
      .from("documents")
      .list("test-folder", { limit: 1 });

    if (uploadTestError) {
      console.log(`   Upload simulation failed: ${uploadTestError.message}`);
      console.log(`   This is why UI uploads are failing!`);
    } else {
      console.log("   ✅ Upload simulation successful");
    }
  } catch (error) {
    console.log("❌ Unexpected error during testing:", error);
  }

  console.log("\n📖 Summary:");
  console.log("If bucket exists but UI still fails, check:");
  console.log("1. RLS policies on the bucket");
  console.log("2. File upload permissions");
  console.log("3. Bucket configuration in Supabase dashboard");
}

async function testBucketExists(
  client: SupabaseClient,
  bucketName: string,
): Promise<BucketTestResult> {
  try {
    const { data: _files, error } = await client.storage
      .from(bucketName)
      .list("", { limit: 1 });

    if (!error) {
      return { exists: true };
    }

    return {
      exists: false,
      error: error.message,
    };
  } catch (error) {
    return {
      exists: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Run the test
testBucketCreation().catch((error) => {
  console.error("💥 Test failed:", error);
  process.exit(1);
});
