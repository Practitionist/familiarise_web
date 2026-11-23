/**
 * Importing this module mocks the boundary of POST /api/checkout for suites that run the
 * real checkout core; import it before the route. Sentry captures reach `captureException`.
 */

export const captureException = jest.fn();

jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: jest.fn(async () => ({
    session: { user: { id: "buyer" } },
  })),
}));
jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: {},
  withCircuitBreaker: (fn: () => unknown) => fn(),
  checkRedisHealth: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../lib/payments/checkout/org-funding", () => ({
  resolveOrgFunding: jest.fn(async (validatedData: unknown) => ({
    validatedData,
    organizationId: null,
    programAssignmentId: null,
    fundingProgramId: null,
    callerMembershipId: null,
    referralCreditsDropped: false,
    billingAccountId: null,
    fundingSource: null,
    creditEffectiveLimit: null,
  })),
  readInvoiceExposurePaise: jest.fn(),
  assertWithinInvoiceCreditLimit: jest.fn(),
}));
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  checkoutLimiter: { limit: jest.fn() },
}));
jest.mock("../../lib/payments/gateway-router", () => ({
  routeGateway: jest.fn(() => ({ gateway: "RAZORPAY", reason: "domestic" })),
}));
jest.mock("../../lib/payments/operations/checkout-replay", () => ({
  replayByIdempotencyKey: jest.fn(async () => null),
  checkoutRequestFingerprint: () => "fp",
}));
jest.mock("../../schemas/checkout", () => ({
  checkoutSchema: { parse: (body: Record<string, unknown>) => ({ ...body }) },
  consumerBuyerStateSchema: { parse: jest.fn() },
}));
jest.mock("../../lib/payments/tax/checkout-context", () => ({
  resolveCheckoutTaxContext: jest.fn(async () => ({ buyerCountry: "IN" })),
}));
jest.mock("../../lib/payments/core/saved-card-customer", () => ({
  savedCardCustomerId: jest.fn(async () => undefined),
}));
jest.mock("@sentry/nextjs", () => ({
  captureException: (...a: unknown[]) => captureException(...a),
  captureMessage: jest.fn(),
  startSpan: (_opts: unknown, fn: () => unknown) => fn(),
  getCurrentScope: () => ({ setTag: jest.fn() }),
  metrics: { count: jest.fn() },
}));
jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));
