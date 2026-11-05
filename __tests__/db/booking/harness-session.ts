/**
 * The signed-in user a database-tier route test acts as, plus the `jest.mock`
 * factories that read it. Dependency-free, so a factory can require it.
 */
export const sessionUser = { current: null as null | Record<string, unknown> };

/** `lib/auth-helpers` answering every route as `sessionUser`. */
export function authAsSessionUser(): object {
  return {
    ...jest.requireActual("../../../lib/auth-helpers"),
    requireApiAuth: async () => ({ session: { user: sessionUser.current } }),
    isPrivileged: () => false,
  };
}

/** `lib/rate-limit` that never limits. */
export function rateLimitOff(): object {
  return {
    ...jest.requireActual("../../../lib/rate-limit"),
    applyRateLimit: async () => null,
  };
}
