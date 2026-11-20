/**
 * Module stand-ins for rendering the learner's appointments adapter as the
 * learner `u-l` on consultee `cee-1`, each used as a `jest.mock` factory
 * through `jest.requireActual`. Nothing here imports app code.
 */

/** `next/navigation` on the learner's appointments route. */
export function learnerNavigationModule(): object {
  return {
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
    useParams: () => ({ consulteeId: "cee-1" }),
  };
}

/** `lib/auth-client`: the signed-in learner. */
export function learnerSessionModule(): object {
  return {
    useSession: () => ({
      data: { user: { id: "u-l", consulteeProfileId: "cee-1", role: "USER" } },
    }),
  };
}

/** `hooks/scheduling/useLazyJoinMeeting`: a join that does nothing. */
export function lazyJoinModule(): object {
  return { useLazyJoinMeeting: () => jest.fn() };
}
