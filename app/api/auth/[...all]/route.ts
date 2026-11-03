import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import { withRetryAfter } from "@/lib/auth/rate-limit";
import {
  classifyMissingSession,
  cookieFromHeader,
  expireSessionCookies,
  verifiedSessionToken,
} from "@/lib/auth/session-cookie";
import { sessionLookupFailedResponse } from "@/lib/auth/session-lookup-error";

const handler = toNextJsHandler(auth);

/** The response with every session cookie expired. */
function withExpiredCookies(response: Response): Response {
  const headers = new Headers(response.headers);
  expireSessionCookies(headers);
  return new Response(response.body, { status: response.status, headers });
}

/**
 * A failed `/get-session` lookup (a 500, or `200 null` while the cookie's row
 * is live) answers 503 so the BetterAuth client keeps its last session. An
 * ended session (a 401 from the refresh hook, or a gone row) has its cookie expired.
 */
async function withLookupFailure(
  request: Request,
  response: Response,
): Promise<Response> {
  if (!new URL(request.url).pathname.endsWith("/get-session")) return response;
  // customSession drops the plugin's cookie deletion when the refresh hook ends the session.
  if (response.status === 401) return withExpiredCookies(response);
  if (response.status === 500) return sessionLookupFailedResponse();
  if (response.status !== 200) return response;
  if ((await response.clone().text()).trim() !== "null") return response;
  const cookieHeader = request.headers.get("cookie");
  const token = verifiedSessionToken((name) =>
    cookieFromHeader(cookieHeader, name),
  );
  if (!token) return response;
  if ((await classifyMissingSession(token)) === "none") {
    return withExpiredCookies(response);
  }
  return sessionLookupFailedResponse();
}

export const GET = async (request: Request) =>
  withRetryAfter(await withLookupFailure(request, await handler.GET(request)));

export const POST = async (request: Request) =>
  withRetryAfter(await handler.POST(request));
