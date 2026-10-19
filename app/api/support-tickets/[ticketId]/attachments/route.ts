import { NextResponse } from "next/server";
function retired() {
  return NextResponse.json(
    {
      error: "Use the evidence actions on the unified support case.",
      code: "ENDPOINT_RETIRED",
    },
    { status: 410 },
  );
}
export const GET = retired;
export const POST = retired;
export const DELETE = retired;
