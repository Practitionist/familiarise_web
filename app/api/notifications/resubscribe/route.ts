/**
 * The unsubscribe page's undo: turns `emailEnabled` back on through the same
 * signed link. POST only, from this site's own page (Origin checked), so a
 * prefetch or a cross-site form can never flip it.
 */

import { NextRequest, NextResponse } from "next/server";
import { isSameOriginRequest } from "@/lib/api/same-origin";
import {
  setEmailEnabled,
  signedLinkUser,
  unsubscribePageUrl,
} from "@/lib/email/unsubscribe";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "cross-site request" }, { status: 403 });
  }
  const { searchParams } = new URL(request.url);
  const userId = signedLinkUser(searchParams);
  if (!userId) {
    return NextResponse.redirect(unsubscribePageUrl("error=1"), 303);
  }
  if (!(await setEmailEnabled(userId, true))) {
    return NextResponse.json({ error: "resubscribe failed" }, { status: 500 });
  }
  const link = new URLSearchParams({ resubscribed: "1", u: userId });
  link.set("t", searchParams.get("t") ?? "");
  return NextResponse.redirect(unsubscribePageUrl(link.toString()), 303);
}
