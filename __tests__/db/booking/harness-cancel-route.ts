/**
 * Import first in a database-tier suite that drives the cancel route, the seat
 * doors or the moderation cancel: it registers the mocks for their edges (the
 * signed-in user, the rate limiter, Novu, Stream chat revocation) before any of
 * those modules load.
 */
jest.mock("../../../lib/auth-helpers", () =>
  jest.requireActual("./harness-session").authAsSessionUser(),
);
jest.mock("../../../lib/rate-limit", () =>
  jest.requireActual("./harness-session").rateLimitOff(),
);
jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/stream/access-revocation", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);

export {};
