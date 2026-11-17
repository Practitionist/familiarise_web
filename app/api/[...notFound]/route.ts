// Any /api path no route claims answers a JSON 404, never the HTML not-found page.
// Every real route outranks a catch-all, so this only sees paths nothing else matches.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function notFound(): NextResponse {
  return NextResponse.json(
    { error: "Not found", code: "NOT_FOUND" },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const OPTIONS = notFound;
