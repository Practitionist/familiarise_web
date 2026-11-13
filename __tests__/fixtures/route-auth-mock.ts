import { NextResponse } from "next/server";

/**
 * The `lib/auth-helpers` boundary for a route test: `requireApiAuth` answers
 * with whichever caller `current()` returns at call time.
 */
export function routeAuthMock(current: () => unknown): object {
  return {
    __esModule: true,
    requireApiAuth: jest.fn(async () => ({ session: { user: current() } })),
    isPrivileged: (role: string) => role === "ADMIN" || role === "STAFF",
    forbiddenResponse: (error: string) =>
      NextResponse.json({ error }, { status: 403 }),
  };
}
