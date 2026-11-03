import { getDomainsWithChildren } from "@/lib/data/taxonomy";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const domains = await getDomainsWithChildren();

    return NextResponse.json(domains);
  } catch (error) {
    console.error("Error fetching domains:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
