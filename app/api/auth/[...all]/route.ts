import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import { withRetryAfter } from "@/lib/auth/rate-limit";
import {
  classifyMissingSession,
  cookieFromHeader,
  verifiedSessionToken,
} from "@/lib/auth/session-cookie";
import { sessionLookupFailedResponse } from "@/lib/auth/session-lookup-error";

const handler = toNextJsHandler(auth);

/**
 * `/get-session` answers `200 null` for a failed lookup as well as a missing
 * session (the customSession plugin swallows the error). With a validly
 * signed cookie whose row is live, that null is a failure: answer 503 so the
 * BetterAuth client keeps its last session instead of rendering signed out.
 */
async function withLookupFailure(
  request: Request,
  response: Response,
): Promise<Response> {
  if (
    response.status !== 200 ||
    !new URL(request.url).pathname.endsWith("/get-session")
  ) {
    return response;
  }
  if ((await response.clone().text()).trim() !== "null") return response;
  const cookieHeader = request.headers.get("cookie");
  const token = verifiedSessionToken((name) =>
    cookieFromHeader(cookieHeader, name),
  );
  if (!token || (await classifyMissingSession(token)) === "none") {
    return response;
  }
  return sessionLookupFailedResponse();
}

export const GET = async (request: Request) =>
  withRetryAfter(await withLookupFailure(request, await handler.GET(request)));

export const POST = async (request: Request) =>
  withRetryAfter(await handler.POST(request));
