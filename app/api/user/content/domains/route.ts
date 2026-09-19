import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";

// Public taxonomy read (no session, no per-user data): safe for shared caching.
const PUBLIC_CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
};

export async function GET() {
  try {
    const domains = await prisma.domain.findMany({
      include: {
        subDomains: true,
        tags: true,
      },
    });

    return NextResponse.json(domains, { headers: PUBLIC_CACHE_HEADERS });
  } catch (error) {
    console.error("Error fetching domains:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
