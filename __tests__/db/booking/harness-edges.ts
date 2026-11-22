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

/** The gateway barrel: no order is minted unless a case sets one, and a cancel answers nothing. */
export function gatewayMock(): object {
  return {
    __esModule: true,
    createPaymentIntent: jest.fn(),
    cancelPaymentIntent: jest.fn(async () => undefined),
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

/** The back-office admin an Ops door suite acts as; a suite seeds the user and sets `id`. */
export const opsAdmin = { id: "" };

/** Back-office auth answers `opsAdmin`, freshly signed in, so step-up passes. */
export function opsAdminAuthMock(): object {
  return {
    ...jest.requireActual("../../../lib/auth-helpers"),
    requireBackofficeSurface: async () => ({
      session: {
        user: { id: opsAdmin.id, role: "ADMIN" },
        session: { createdAt: new Date() },
      },
    }),
  };
}

/** No money-ops budget is spent. */
export function moneyBudgetMock(): object {
  return {
    __esModule: true,
    assertMoneyOpsBudget: jest.fn(async () => undefined),
  };
}

/** The gateway barrel for a checkout: every order gets a fresh id, and a cancel answers nothing. */
export function orderGatewayMock(): object {
  return {
    __esModule: true,
    createPaymentIntent: jest.fn(async () => ({
      id: `order_${globalThis.crypto.randomUUID()}`,
      client_secret: null,
    })),
    cancelPaymentIntent: jest.fn(async () => undefined),
  };
}

/** Every consent check passes. */
export function consentGrantedMock(): object {
  return { __esModule: true, checkConsent: jest.fn(async () => true) };
}

/** Emails render to a fixed body, so staging never loads the templates. */
export function renderedEmailMock(): object {
  return {
    __esModule: true,
    renderEmail: async () => ({ html: "<p>rendered</p>", text: "rendered" }),
  };
}
