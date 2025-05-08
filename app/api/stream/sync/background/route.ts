import { performStreamUserSync, SyncSummary } from "@/jobs/stream-sync"; // Removed FailedDeletionEntry from import if not directly used, or ensure no local conflict
import { NextResponse } from "next/server";
import { StreamChat } from "stream-chat";

const streamApiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;
const streamApiSecret = process.env.STREAM_API_SECRET;

console.log(
  "[Stream Sync BG] Initializing. Key Loaded:",
  !!streamApiKey,
  "Secret Loaded:",
  !!streamApiSecret,
);

if (!streamApiKey || !streamApiSecret) {
  console.error(
    "[Stream Sync BG] Critical: Stream API Key or Secret is not defined.",
  );
  // For a background job, throwing an error might be appropriate if it cannot run.
  // However, for an API route trigger, returning a 500 is also an option.
  // Corrected: The route handler must be exported, so can't return directly here.
  // This top-level check is more for immediate feedback during deployment/startup if possible.
  // The actual enforcement for a request will happen inside POST.
}

const serverStreamClient = StreamChat.getInstance(
  streamApiKey!,
  streamApiSecret!,
  {
    timeout: 30000, // Increased timeout for potentially longer operations (30 seconds)
  },
);

interface FailedDeletionFromSDK {
  user_id: string;
  message: string;
}

const EXCLUDED_USER_IDS = new Set(["system", "teetangh"]); // Add any specific user IDs to always exclude

export async function POST(request: Request) {
  // 1. Security Check
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get("secret");
  if (secret !== process.env.STREAM_SYNC_SECRET) {
    console.warn("[Stream Sync API Route] Unauthorized attempt.");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  console.log("[Stream Sync API Route] Authorized. Triggering sync process...");

  try {
    // Call the reusable synchronization function
    const summary: SyncSummary = await performStreamUserSync();

    console.log(
      "[Stream Sync API Route] Synchronization process completed via API call.",
    );
    return NextResponse.json(
      {
        message:
          "Stream user background synchronization triggered and completed.",
        summary: summary,
      },
      { status: 200 },
    );
  } catch (error: any) {
    console.error(
      "[Stream Sync API Route] Error during synchronization process:",
      error.message,
    );
    // The performStreamUserSync function might throw errors (e.g., config errors)
    // Or operational errors if not caught and rethrown by it.
    return NextResponse.json(
      {
        error: "Internal Server Error during background sync via API call",
        details: error.message,
        // Optionally, you could return partial summary if performStreamUserSync provides it before throwing
      },
      { status: 500 },
    );
  }
}

// Note: Vercel Cron Jobs call these API routes.
// The job is considered successful if the route returns a 2xx status code.
// For long-running jobs, ensure your serverless function timeout on Vercel is sufficient.
// (Hobby plan: 10s-15s, Pro plan: up to 5 minutes, Enterprise: up to 15 minutes for background functions)
// If this process takes longer than your plan allows, you'd need a different architecture (e.g., a queue and worker system).
