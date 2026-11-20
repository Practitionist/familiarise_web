/**
 * `jest.mock` factories for the edges a database-tier route suite stubs, and
 * the handle on the refund door `../setup.ts` stubs. A factory module must not
 * import the route under test, so nothing here does.
 */

/** The user `requireApiAuth` answers with; a suite sets it per test. */
export const sessionUser = { current: null as null | Record<string, unknown> };

/** Auth answers `sessionUser`, never privileged. */
export function authHelpersMock(): object {
  return {
    ...jest.requireActual("../../../lib/auth-helpers"),
    requireApiAuth: async () => ({ session: { user: sessionUser.current } }),
    isPrivileged: () => false,
  };
}

/** No rate limit. */
export function rateLimitMock(): object {
  return {
    ...jest.requireActual("../../../lib/rate-limit"),
    applyRateLimit: async () => null,
  };
}

/** Chat access revocation does nothing. */
export function chatRevocationMock(): object {
  return {
    revokeEndedSeatAccess: jest.fn(async () => undefined),
    persistSeatRevocation: jest.fn(async () => undefined),
    persistSeatRevocationInTx: jest.fn(async () => null),
  };
}

/** Staged notifications are staged for real and never flushed. */
export function noFlushMock(): object {
  return {
    __esModule: true,
    flushNotificationsAfter: jest.fn(async () => undefined),
    stageNowAttemptAfter: jest.fn(
      async (_label: string, stage: () => Promise<unknown>) => {
        await stage();
      },
    ),
  };
}

/** The stubbed refund door every suite shares (see `../setup.ts`). */
export const refundDoor = jest.requireMock(
  "../../../lib/payments/operations/booking-refund",
) as { refundBookingPayment: jest.Mock };
