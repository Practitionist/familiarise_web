/**
 * Imported for its effect, ahead of the module under test: the database's
 * host-time locks find every atom free.
 */
jest.mock("../../lib/booking/allocation/host-time-locks", () =>
  jest.requireActual("./lock-mocks").hostTimeLocksModule(),
);
