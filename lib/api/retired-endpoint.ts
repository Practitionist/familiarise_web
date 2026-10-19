import { NextResponse } from "next/server";

/**
 * A retired support endpoint. The canonical case API is `/api/support/cases`;
 * the pre-cutover ticket and conversation routes answer 410 so an old client
 * fails loudly instead of silently creating a second, unreadable case.
 *
 * One responder for all of them, so the message and the status code cannot
 * drift apart between the seven retired routes.
 */
export function retiredSupportEndpoint(): NextResponse {
  return NextResponse.json(
    {
      error: "Use /api/support/cases for support requests.",
      code: "ENDPOINT_RETIRED",
    },
    { status: 410 },
  );
}
