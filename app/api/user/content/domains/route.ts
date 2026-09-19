import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";
import { PUBLIC_LIST_HEADERS } from "@/lib/api/cache-headers";

// Public taxonomy read (no session, no per-user data): safe for shared caching.
export async function GET() {
  try {
    const domains = await prisma.domain.findMany({
      include: {
        subDomains: true,
        tags: true,
      },
    });

    return NextResponse.json(domains, { headers: PUBLIC_LIST_HEADERS });
  } catch (error) {
    console.error("Error fetching domains:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
