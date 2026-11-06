import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { cookies } from "next/headers";
import {
  readCookiePreferences,
  saveCookiePreferences,
  type CookieIdentity,
} from "@/lib/compliance/cookie-preferences";
import { cookiePreferenceUpdateSchema } from "@/schemas/cookie-preferences";

const SESSION_COOKIE = "cp_sid";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
async function resolveIdentity(
  mintCookie: boolean,
): Promise<CookieIdentity | null> {
  const session = await getSession();
  if (session?.user?.id) return { userId: session.user.id };
  const jar = await cookies();
  const parsed = z.string().uuid().safeParse(jar.get(SESSION_COOKIE)?.value);
  if (parsed.success) return { sessionId: parsed.data };
  if (!mintCookie) return null;
  const sessionId = crypto.randomUUID();
  jar.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 365 * 86400,
  });
  return { sessionId };
}

export async function GET() {
  try {
    const identity = await resolveIdentity(false);
    return NextResponse.json(
      identity
        ? await readCookiePreferences(prisma, identity)
        : { essential: true, analytics: false, marketing: false },
      { headers },
    );
  } catch {
    return NextResponse.json(
      { error: "Cookie preferences could not be loaded" },
      { status: 503, headers },
    );
  }
}

export async function PUT(req: NextRequest) {
  const parsed = cookiePreferenceUpdateSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success)
    return NextResponse.json(
      { error: "Invalid cookie preferences" },
      { status: 400, headers },
    );
  try {
    const identity = await resolveIdentity(true);
    if (!identity)
      return NextResponse.json(
        { error: "No identity" },
        { status: 401, headers },
      );
    const result = await prisma.$transaction((tx) =>
      saveCookiePreferences(tx, identity, parsed.data),
    );
    return NextResponse.json(result.preferences, { headers });
  } catch {
    return NextResponse.json(
      { error: "Cookie preferences could not be saved" },
      { status: 503, headers },
    );
  }
}
