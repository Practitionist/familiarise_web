import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import {
  adoptFamiliariseInboxSettings,
  readInboxRestrictions,
} from "@/lib/novu/inbox-preferences";

async function authorizedUser() {
  const session = await getSession();
  if (!session?.user?.id) return null;
  return prisma.user.findFirst({
    where: { id: session.user.id, erasedAt: null, emailVerified: true },
    select: { id: true },
  });
}
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export async function GET() {
  try {
    const user = await authorizedUser();
    if (!user)
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401, headers },
      );
    return NextResponse.json(await readInboxRestrictions(user.id), { headers });
  } catch {
    return NextResponse.json(
      { error: "Existing inbox choices could not be checked. Try again." },
      { status: 503, headers },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await authorizedUser();
    if (!user)
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401, headers },
      );
    if (
      req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
      "application/json"
    )
      return NextResponse.json(
        { error: "JSON confirmation required" },
        { status: 415, headers },
      );
    const parsed = z
      .object({ useFamiliariseSettings: z.literal(true) })
      .strict()
      .safeParse(await req.json().catch(() => null));
    if (!parsed.success)
      return NextResponse.json(
        { error: "Confirm use of Familiarise settings" },
        { status: 400, headers },
      );
    const remaining = await adoptFamiliariseInboxSettings(user.id);
    if (remaining.globalMuted || remaining.workflows.length > 0)
      return NextResponse.json(
        {
          error:
            "Some earlier inbox choices remain. Try again before relying on the new settings.",
        },
        { status: 409, headers },
      );
    return NextResponse.json(remaining, { headers });
  } catch {
    return NextResponse.json(
      {
        error:
          "Inbox settings could not be confirmed. Your Familiarise choices are unchanged; try again.",
      },
      { status: 503, headers },
    );
  }
}
