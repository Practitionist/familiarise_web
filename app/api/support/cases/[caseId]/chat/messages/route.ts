import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { refusalResponse } from "@/lib/backoffice/ops-refusal";
import { supportError } from "@/lib/api/support-http";
import { assertBodySize } from "@/lib/validation/limits";
import { postSupportMessage } from "@/lib/stream/support-intervention";
import { PostSupportMessageBody } from "@/schemas/support-chat";

const Params = z.object({ caseId: z.string().min(1).max(64) });

/** Posts as Familiarise Support on a live, joined intervention; audited before the send. */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ caseId: string }> },
) {
  const auth = await requireBackofficeSurface("supportChat.intervene", {
    expectUser: true,
  });
  if (auth.error) return auth.error;
  const tooLarge = assertBodySize(req);
  if (tooLarge) return tooLarge;
  const params = Params.safeParse(await context.params);
  const body = PostSupportMessageBody.safeParse(
    await req.json().catch(() => null),
  );
  if (!params.success || !body.success)
    return NextResponse.json(
      {
        error: body.error?.issues[0]?.message ?? "Invalid message",
        code: "INVALID_BODY",
      },
      { status: 400 },
    );
  try {
    const data = await postSupportMessage({
      caseId: params.data.caseId,
      grantId: body.data.grantId,
      clientActionId: body.data.clientActionId,
      text: body.data.text,
      actor: {
        userId: auth.session.user.id,
        role: String(auth.session.user.role ?? "UNKNOWN"),
      },
    });
    return NextResponse.json({ data }, { status: data.replayed ? 200 : 201 });
  } catch (error) {
    const refused = refusalResponse(error);
    if (refused) return refused;
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause: error,
      context: { route: "support.case.chat.messages" },
    });
  }
}
