import { fetchExpertsMetadata } from "@/lib/data/explore-experts";
import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/errors";

export async function GET(req: NextRequest) {
  try {
    const metadata = await fetchExpertsMetadata();

    return NextResponse.json(
      { data: metadata },
      {
        status: 200,
        headers: {
          "Cache-Control":
            "public, s-maxage=300, stale-while-revalidate=600",
        },
      },
    );
  } catch (error) {
    return apiError({ tag: "[ConsultantsMeta.GET]", error });
  }
}
