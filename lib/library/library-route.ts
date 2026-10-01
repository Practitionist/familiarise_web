import { NextResponse, type NextRequest } from "next/server";

import type { OrgAccessGrant } from "@/lib/auth-helpers";
import {
  libraryScopeFor,
  parseLibraryQuery,
  type LibraryQuery,
  type LibraryScope,
} from "@/lib/library/library-query";

/** Scope + filters for an org Library route, or its 403 (#1527). */
export function libraryRequest(
  req: NextRequest,
  access: Pick<OrgAccessGrant, "member" | "session">,
):
  | {
      ok: true;
      args: { userId: string; scope: LibraryScope; query: LibraryQuery };
    }
  | { ok: false; response: NextResponse } {
  const sp = req.nextUrl.searchParams;
  const scope = libraryScopeFor(sp.get("scope"), access.member);
  if (!scope) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "You can only see your own sessions' files." },
        { status: 403 },
      ),
    };
  }
  return {
    ok: true,
    args: {
      userId: access.session.user.id,
      scope,
      query: parseLibraryQuery((key) => sp.get(key)),
    },
  };
}
