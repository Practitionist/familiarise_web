/**
 * One-click unsubscribe from optional email notifications.
 *
 * GET  — a human clicked the footer link. Verifies the token and sends them to
 *        the confirmation page; flips nothing, because link scanners prefetch.
 * POST — RFC 8058 one-click from Gmail/Yahoo via List-Unsubscribe-Post, or the
 *        confirmation page's form. Flips `emailEnabled` only: the category
 *        switches are shared with the bell, and the bell was not the complaint.
 *
 * The token is the only guard; no session and no rate limit. The response
 * never says whether the user exists. The undo is `../resubscribe`.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  setEmailEnabled,
  signedLinkUser,
  unsubscribePageUrl,
} from "@/lib/email/unsubscribe";

export const dynamic = "force-dynamic";

function toPage(query: string): NextResponse {
  return NextResponse.redirect(unsubscribePageUrl(query), 303);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { search, searchParams } = new URL(request.url);
  if (!signedLinkUser(searchParams)) return toPage("error=1");
  return toPage(search.slice(1));
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const userId = signedLinkUser(searchParams);
  // The page's <form> wants to land back on the page; a mail client wants JSON.
  const wantsHtml =
    request.headers.get("accept")?.includes("text/html") ?? false;

  if (!userId) {
    return wantsHtml
      ? toPage("error=1")
      : NextResponse.json({ error: "invalid link" }, { status: 400 });
  }

  if (!(await setEmailEnabled(userId, false))) {
    return NextResponse.json({ error: "unsubscribe failed" }, { status: 500 });
  }

  // The done page keeps the signed pair so it can offer the undo.
  const link = new URLSearchParams({ done: "1", u: userId });
  link.set("t", searchParams.get("t") ?? "");
  return wantsHtml ? toPage(link.toString()) : NextResponse.json({ ok: true });
}
