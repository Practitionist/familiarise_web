import { getSubDomains } from "@/lib/data/taxonomy";
import { NextRequest, NextResponse } from "next/server";
import { reportSentryError } from "@/lib/observability/report";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const domainId = searchParams.get("domainId");

    const subDomains = await getSubDomains(domainId ?? undefined);

    return NextResponse.json(subDomains);
  } catch (error) {
    reportSentryError(error, {
      subsystem: "content",
      op: "subdomains.list",
      expected: false,
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
