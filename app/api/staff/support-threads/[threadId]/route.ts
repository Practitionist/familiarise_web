import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json(
    {
      error: "Use /api/support/cases for support requests.",
      code: "ENDPOINT_RETIRED",
    },
    { status: 410 },
  );
}

export function POST() {
  return NextResponse.json(
    {
      error: "Use /api/support/cases for support requests.",
      code: "ENDPOINT_RETIRED",
    },
    { status: 410 },
  );
}

export function PATCH() {
  return NextResponse.json(
    {
      error: "Use /api/support/cases for support requests.",
      code: "ENDPOINT_RETIRED",
    },
    { status: 410 },
  );
}
