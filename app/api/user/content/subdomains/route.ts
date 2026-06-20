import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

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

    return NextResponse.json(subDomains);
  } catch (error) {
    console.error("Error fetching subdomains:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
