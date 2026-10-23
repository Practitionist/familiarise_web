import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { refusalResponse } from "@/lib/backoffice/ops-refusal";
import { supportError } from "@/lib/api/support-http";
import { readTranscriptPage } from "@/lib/support/chat-transcript";
import { TranscriptQuery } from "@/schemas/support-chat";

const Params = z.object({ caseId: z.string().min(1).max(64) });

/** One audited transcript page under the caller's live grant; never cached. */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ caseId: string }> },
) {
  const auth = await requireBackofficeSurface("supportChat.read", {
    expectUser: true,
  });
  if (auth.error) return auth.error;
  const params = Params.safeParse(await context.params);
  const query = TranscriptQuery.safeParse(
    Object.fromEntries(req.nextUrl.searchParams),
  );
  if (!params.success || !query.success)
    return NextResponse.json(
      { error: "Invalid request", code: "INVALID_QUERY" },
      { status: 400 },
    );
  try {
    const data = await readTranscriptPage({
      caseId: params.data.caseId,
      grantId: query.data.grantId,
      before: query.data.before,
      actor: {
        userId: auth.session.user.id,
        role: String(auth.session.user.role ?? "UNKNOWN"),
      },
    });
    return NextResponse.json(
      { data },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const refused = refusalResponse(error);
    if (refused) return refused;
    // An unaudited page is never served: a failed audit write lands here too.
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause: error,
      context: { route: "support.case.chat.transcript" },
    });
  }
}
