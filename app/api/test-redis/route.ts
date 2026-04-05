import { NextResponse } from "next/server";
import redisClient from "../../../lib/redis";

export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available" }, { status: 403 });
  }

  try {
    // Test basic SET operation
    const testKey = `test-${Date.now()}`;
    const testValue = "hello-upstash";

    console.log("Testing Redis connection...");
    console.log("URL:", process.env.UPSTASH_REDIS_REST_URL);
    console.log("Token length:", process.env.UPSTASH_REDIS_REST_TOKEN?.length);

    const setResult = await redisClient.set(testKey, testValue);
    console.log("SET result:", setResult);

    const getResult = await redisClient.get(testKey);
    console.log("GET result:", getResult);

    // Test SET NX PX
    const lockKey = `lock-test-${Date.now()}`;
    const lockResult = await redisClient.set(lockKey, "locked", {
      nx: true,
      px: 5000,
    });
    console.log("LOCK result:", lockResult);

    return NextResponse.json({
      success: true,
      setResult,
      getResult,
      lockResult,
      env: {
        hasUrl: !!process.env.UPSTASH_REDIS_REST_URL,
        hasToken: !!process.env.UPSTASH_REDIS_REST_TOKEN,
        tokenLength: process.env.UPSTASH_REDIS_REST_TOKEN?.length,
      },
    });
  } catch (error: unknown) {
    console.error("Redis test error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      { status: 500 },
    );
  }
}
