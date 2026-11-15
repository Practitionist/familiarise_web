/**
 * Module stand-ins for `POST /api/trials` route tests, each used as a
 * `jest.mock` factory through `jest.requireActual`.
 */

/** `lib/trials/book-trial`: the trial insert on the caller's client stands in for the whole booking write. */
export function bookTrialModule(): object {
  return {
    lockTrialPick: jest.fn(async () => async () => undefined),
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
  };
}

/** `lib/trials/schedule-notices`: nothing staged. */
export function scheduleNoticesModule(): object {
  return {
    stageTrialScheduledNotices: jest.fn(async () => ({
      consulteeBell: null,
      consultantBell: null,
      emails: [],
    })),
  };
}

/** `lib/email/senders/booking`: a prepared confirmation with no messages. */
export function bookingEmailModule(): object {
  return {
    prepareTrialScheduledEmail: jest.fn(async () => ({
      emailType: "TRIAL_SESSION_SCHEDULED",
      entityRef: "trial:pending",
      messages: [],
      skipped: 0,
      failed: 0,
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
    RequestCapBusyError: class extends Error {},
    BookingLockUnavailableError: class extends Error {},
  };
}
