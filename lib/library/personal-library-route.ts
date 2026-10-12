import "server-only";

import { NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import {
  forbiddenResponse,
  isPrivileged,
  requireApiAuth,
} from "@/lib/auth-helpers";
import { parseLibraryQuery, type LibraryQuery } from "./library-query";

/** Auth and filters for a personal Library route: the profile's owner, or staff inspecting it. */
export async function personalLibraryRequest(
  request: Request,
  kind: "consultee" | "consultant",
  profileId: string,
): Promise<
  | { ok: true; userId: string; query: LibraryQuery }
  | { ok: false; response: NextResponse }
> {
  const auth = await requireApiAuth();
  if (auth.error) return { ok: false, response: auth.error };
  const user = auth.session.user;
  const owned =
    kind === "consultee" ? user.consulteeProfileId : user.consultantProfileId;
  if (owned !== profileId && !isPrivileged(user.role)) {
    return {
      ok: false,
      response: forbiddenResponse("You can only see your own library"),
    };
  }
  const profile =
    kind === "consultee"
      ? await prisma.consulteeProfile.findUnique({
          where: { id: profileId },
          select: { userId: true },
        })
      : await prisma.consultantProfile.findUnique({
          where: { id: profileId },
          select: { userId: true },
        });
  if (!profile) {
    return {
      ok: false,
      response: NextResponse.json(
        { code: "NOT_FOUND", message: "Profile not found." },
        { status: 404 },
      ),
    };
  }
  const sp = new URL(request.url).searchParams;
  return {
    ok: true,
    userId: profile.userId,
    query: parseLibraryQuery((key) => sp.get(key)),
  };
}
