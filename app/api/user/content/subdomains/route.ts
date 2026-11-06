import { getSubDomains } from "@/lib/data/taxonomy";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const domainId = searchParams.get("domainId");

    const subDomains = await getSubDomains(domainId ?? undefined);

    return NextResponse.json(subDomains);
  } catch (error) {
    console.error("Error fetching subdomains:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
