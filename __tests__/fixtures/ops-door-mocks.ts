/**
 * Module stand-ins for the back-office money doors' route tests, each used as a
 * `jest.mock` factory through `jest.requireActual`.
 */

/** `lib/auth-helpers`: an admin, freshly signed in, so step-up passes. */
export function adminSurfaceModule(): object {
  return {
    requireBackofficeSurface: jest.fn(async () => ({
      session: {
        user: { id: "admin_1", role: "ADMIN" },
        session: { createdAt: new Date() },
      },
    })),
  };
}

/** `lib/backoffice/money-limit`: no money-ops budget is spent. */
export function moneyBudgetModule(): object {
  return { assertMoneyOpsBudget: jest.fn() };
}

/** `lib/backoffice/refund-eligibility`: every door is open; eligibility has its own suite on real rows. */
export function openRefundDoorModule(): object {
  return { assertRefundDoorOpen: jest.fn(async () => undefined) };
}
