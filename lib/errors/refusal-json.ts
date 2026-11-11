import { NextResponse } from "next/server";

import { isRefusal } from "@/lib/errors/refusal";

/** A route's JSON answer to a typed refusal (code, user copy, status); null for any other error. */
export function refusalJson(error: unknown): NextResponse | null {
  if (!isRefusal(error)) return null;
  return NextResponse.json(
    { error: error.userMessage, code: error.code },
    { status: error.httpStatus },
  );
}
