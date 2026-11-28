/**
 * Module stand-ins for `POST /api/trials` route tests, each used as a
 * `jest.mock` factory through `jest.requireActual`.
 */

/** `lib/trials/book-trial`: the trial insert on the caller's client stands in for the whole booking write. */
export function bookTrialModule(): object {
  return {
    lockTrialPick: jest.fn(async () => async () => undefined),
    lockTrialPickInTx: jest.fn(async () => undefined),
    bookTrialInTx: jest.fn(
      async (
        tx: { trial: { create: (a: unknown) => Promise<object> } },
        args: Record<string, unknown>,
      ) => ({
        ...(await tx.trial.create({ data: args })),
        appointmentId: "apt-1",
      }),
    ),
    TrialTimeRefusedError: class extends Error {},
    TrialPairHeldError: class extends Error {},
    TrialDailyLimitError: class extends Error {},
  };
}

/** `lib/trials/schedule-notices`: nothing prepared or staged. */
export function scheduleNoticesModule(): object {
  return {
    prepareTrialScheduledNotices: jest.fn(async () => ({
      bells: [],
      emails: { prepared: { messages: [] }, screened: [] },
    })),
    stageTrialScheduledNotices: jest.fn(async () => ({
      bells: [],
      emails: [],
    })),
  };
}

/** `lib/novu/stage-then-attempt`: the after-commit flush does nothing. */
export function flushNotificationsModule(): object {
  return { flushNotificationsAfter: jest.fn(async () => undefined) };
}

/** `utils/appointmentlock`: the request-cap lock is always granted. */
export function requestCapLockModule(): object {
  return {
    lockRequestCap: jest.fn(async () => ({ key: "request-cap" })),
    unlockRequestCap: jest.fn(async () => undefined),
    requestLockBudget: () => ({}),
    RequestCapBusyError: class extends Error {},
    BookingLockUnavailableError: class extends Error {},
    // The consultee key's busy answer, with the real one's status and code.
    ConsulteeBookingBusyError: class extends Error {
      readonly httpStatus = 409;
      readonly retryAfterSeconds = 30;
      readonly code = "CONSULTEE_BOOKING_BUSY";
    },
  };
}
