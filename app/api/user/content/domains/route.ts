import { getDomainsWithChildren } from "@/lib/data/taxonomy";
import { NextResponse } from "next/server";
import { reportSentryError } from "@/lib/observability/report";

export async function GET() {
  try {
    const domains = await getDomainsWithChildren();

    return NextResponse.json(domains);
  } catch (error) {
    reportSentryError(error, {
      subsystem: "content",
      op: "domains.list",
      expected: false,
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
