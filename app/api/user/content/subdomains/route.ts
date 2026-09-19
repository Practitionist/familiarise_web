import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// Public taxonomy read (no session, no per-user data; varies by ?domainId=):
// safe for shared caching.
const PUBLIC_CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
};

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const domainId = searchParams.get("domainId");

    const subDomains = await prisma.subDomain.findMany({
      where: domainId ? { domainId } : undefined,
      include: {
        domain: true,
      },
    });

    return NextResponse.json(subDomains, { headers: PUBLIC_CACHE_HEADERS });
  } catch (error) {
    console.error("Error fetching subdomains:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
