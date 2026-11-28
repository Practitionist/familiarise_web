/**
 * Doubles for the booking locks, for a suite that mocks them wholesale. Each
 * one is pinned in its own suite (`redis-calls-bounded`, `host-time-locks`).
 */

/**
 * The request-deadline exports of `utils/appointmentlock`. A suite spreads
 * this first in its own factory, so every double it declares itself wins.
 */
export function lockDoubles() {
  return {
    requestLockBudget: () => ({}),
    renewConsulteeBooking: jest.fn(async () => undefined),
    ConsulteeBookingBusyError: class extends Error {},
    // A door takes its tiers through this; it hands back the suite's own doubles.
    requestLockTiers: () => {
      const locks = jest.requireMock("../../utils/appointmentlock");
      return {
        withEventCheckoutLock: locks.withEventCheckoutLock,
        withAppointmentLock: locks.withAppointmentLock,
      };
    },
  };
}

/** `lib/booking/allocation/host-time-locks` with every atom free. */
export function hostTimeLocksModule() {
  return { lockHostTimeInTx: jest.fn(async () => undefined) };
}
