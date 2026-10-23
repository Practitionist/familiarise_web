import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { sessionRole } from "@/lib/auth/session-role";
import { refusalResponse } from "@/lib/backoffice/ops-refusal";
import { supportError } from "@/lib/api/support-http";
import { assertBodySize } from "@/lib/validation/limits";
import {
  CASE_CHAT_SELECT,
  caseChatRefusal,
  caseNotFound,
  readCaseChatStatus,
  resolveCaseChat,
} from "@/lib/support/chat-access";
import {
  endChatReadDoor,
  endInterventionDoor,
  openChatReadDoor,
  startInterventionDoor,
} from "@/lib/support/chat-doors";
import { probeSupportChannel } from "@/lib/stream/support-intervention";
import { SupportChatActionBody } from "@/schemas/support-chat";

const Params = z.object({ caseId: z.string().min(1).max(64) });
interface Context {
  params: Promise<{ caseId: string }>;
}

const DOORS = {
  OPEN_READ: openChatReadDoor,
  START_INTERVENTION: startInterventionDoor,
  END_READ: endChatReadDoor,
  END_INTERVENTION: endInterventionDoor,
} as const;

/** Eligibility, parties and grants for the staff chat panel. */
export async function GET(_req: NextRequest, context: Context) {
  const auth = await requireBackofficeSurface("supportChat.read");
  if (auth.error) return auth.error;
  const params = Params.safeParse(await context.params);
  if (!params.success)
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const role = sessionRole(auth.session.user.role);
  try {
    const data = await readCaseChatStatus(prisma, {
      caseId: params.data.caseId,
      actorId: auth.session.user.id,
      canIntervene: hasBackofficePermission(role, "supportChat.intervene"),
      now: new Date(),
    });
    if (!data)
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(
      { data },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause: error,
      context: { route: "support.case.chat" },
    });
  }
}

/** A frozen or missing channel can't take a visible member; refused before the door's transaction. */
async function interventionChannelRefusal(caseId: string) {
  const supportCase = await prisma.supportCase.findUnique({
    where: { id: caseId },
    select: CASE_CHAT_SELECT,
  });
  if (!supportCase) throw caseNotFound();
  const refusal = caseChatRefusal(supportCase);
  if (refusal) throw refusal;
  const chat = await resolveCaseChat(prisma, supportCase);
  const probe = await probeSupportChannel(chat.channelType, chat.channelId);
  if (!probe.exists)
    return NextResponse.json(
      {
        error:
          "This booking chat hasn't been started yet, so there is nothing to join.",
        code: "CHAT_NOT_FOUND",
      },
      { status: 404 },
    );
  if (probe.frozen)
    return NextResponse.json(
      {
        error:
          "This booking chat is frozen; Familiarise Support can't join it.",
        code: "CHANNEL_FROZEN",
      },
      { status: 409 },
    );
  return null;
}

/** Dispatches to the audited door for the action; each door re-checks its own surface and step-up. */
export async function POST(req: NextRequest, context: Context) {
  const auth = await requireBackofficeSurface("supportChat.read", {
    expectUser: true,
  });
  if (auth.error) return auth.error;
  const tooLarge = assertBodySize(req);
  if (tooLarge) return tooLarge;
  const params = Params.safeParse(await context.params);
  const raw: unknown = await req.json().catch(() => null);
  const parsed = SupportChatActionBody.safeParse(raw);
  if (!parsed.success || !params.success)
    return NextResponse.json(
      {
        error: parsed.error?.issues[0]?.message ?? "Invalid action",
        code: "INVALID_ACTION",
      },
      { status: 400 },
    );
  if (
    parsed.data.action === "START_INTERVENTION" &&
    hasBackofficePermission(
      sessionRole(auth.session.user.role),
      "supportChat.intervene",
    )
  ) {
    try {
      const refused = await interventionChannelRefusal(params.data.caseId);
      if (refused) return refused;
    } catch (error) {
      const refused = refusalResponse(error);
      if (refused) return refused;
      return supportError({
        status: 500,
        code: "INTERNAL",
        cause: error,
        context: { route: "support.case.chat.probe" },
      });
    }
  }
  return DOORS[parsed.data.action](
    new NextRequest(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(raw),
    }),
    context,
  );
}
