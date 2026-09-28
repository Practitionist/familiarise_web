/**
 * @jest-environment node
 */

/**
 * The `session.create.after` wiring in `lib/auth.ts` (#1856, review
 * follow-up).
 *
 * Both helpers are unit-tested on their own. Nothing tested that the
 * HOOK calls them, in order, awaits them, and couples an eviction to the
 * cross-device signal — and the last two commits on this branch
 * (`5fbb3f33` "await cap enforcement", `60377056` "correct the record")
 * were both fixes in exactly this block. A regression to
 * fire-and-forget would have shipped silently.
 *
 * `lib/auth.ts` cannot be imported here (it constructs the whole
 * BetterAuth instance, which needs the adapter, env and every plugin),
 * so this reads the hook out of the source and exercises it against
 * mocks. That is a real trade: it is source-shape-coupled, so a
 * reformat breaks it. It is still worth more than nothing, because the
 * alternative is the properties going entirely unasserted.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(process.cwd(), "lib/auth.ts"), "utf8");

/** The body of the `session.create.after` arrow, braces balanced. */
function extractAfterHookBody(): string {
  const anchor = SOURCE.indexOf("after: async (session) => {");
  if (anchor === -1) {
    throw new Error("session.create.after hook not found in lib/auth.ts");
  }
  const start = SOURCE.indexOf("{", anchor);
  let depth = 0;
  for (let i = start; i < SOURCE.length; i++) {
    if (SOURCE[i] === "{") depth++;
    else if (SOURCE[i] === "}") {
      depth--;
      if (depth === 0) return SOURCE.slice(start + 1, i);
    }
  }
  throw new Error("unbalanced braces in session.create.after");
}

const HOOK_BODY = extractAfterHookBody();

const stampSessionDeviceMetadata = jest.fn();
jest.mock("../../lib/auth/session-stamp", () => ({
  __esModule: true,
  stampSessionDeviceMetadata: (...a: unknown[]) =>
    stampSessionDeviceMetadata(...a),
}));

const enforceSessionCapForUser = jest.fn();
jest.mock("../../lib/auth/session-cap", () => ({
  __esModule: true,
  MAX_CONCURRENT_SESSIONS: 10,
  enforceSessionCapForUser: (...a: unknown[]) => enforceSessionCapForUser(...a),
}));

const signalRevocation = jest.fn();
jest.mock("../../lib/auth/session-revoke", () => ({
  __esModule: true,
  signalRevocation: (...a: unknown[]) => signalRevocation(...a),
}));

const captureException = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: (...a: unknown[]) => captureException(...a),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/** Run the hook body the way BetterAuth does: awaited, with the row. */
async function runHook(session: {
  id: string;
  userId: string;
  userAgent: string | null;
}): Promise<void> {
  // The hook body contains `await`, so it needs the async constructor.
  const AsyncFunction = Object.getPrototypeOf(async function () {})
    .constructor as new (
    ...args: string[]
  ) => (s: unknown, ...rest: unknown[]) => Promise<void>;
  const fn = new AsyncFunction(
    "session",
    "stampSessionDeviceMetadata",
    "enforceSessionCapForUser",
    "MAX_CONCURRENT_SESSIONS",
    "signalRevocation",
    "Sentry",
    `"use strict";${HOOK_BODY}`,
  );
  await fn(
    session,
    stampSessionDeviceMetadata,
    enforceSessionCapForUser,
    10,
    signalRevocation,
    { captureException },
  );
}

const SESSION = {
  id: "s-new",
  userId: "u1",
  userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/126.0.0.0 Safari/537.36",
};

beforeEach(() => {
  jest.clearAllMocks();
  stampSessionDeviceMetadata.mockResolvedValue(undefined);
  enforceSessionCapForUser.mockResolvedValue({ evicted: 0 });
  signalRevocation.mockResolvedValue(undefined);
});

describe("session.create.after wiring (#1856 review)", () => {
  it("stamps the device metadata from the created row", async () => {
    await runHook(SESSION);

    expect(stampSessionDeviceMetadata).toHaveBeenCalledWith(
      "s-new",
      SESSION.userAgent,
    );
  });

  it("enforces the cap with the just-created session RESERVED", async () => {
    // Reservation is load-bearing: `createdAt` has millisecond
    // resolution and instance clocks skew, so ordering alone could rank
    // the fresh row outside the keep window and hand the user a cookie
    // for a deleted row.
    await runHook(SESSION);

    expect(enforceSessionCapForUser).toHaveBeenCalledWith("u1", 10, "s-new");
  });

  it("signals only when the cap actually evicted something", async () => {
    enforceSessionCapForUser.mockResolvedValue({ evicted: 0 });
    await runHook(SESSION);
    expect(signalRevocation).not.toHaveBeenCalled();

    jest.clearAllMocks();
    stampSessionDeviceMetadata.mockResolvedValue(undefined);
    enforceSessionCapForUser.mockResolvedValue({ evicted: 3 });
    await runHook(SESSION);
    expect(signalRevocation).toHaveBeenCalledWith("u1");
  });

  it("AWAITS the cap — a floating promise dies with the serverless freeze", async () => {
    // The specific regression `5fbb3f33` fixed, and the one the module
    // docstring argues at length: with the freeze, work started but not
    // awaited never completes, and with no later sign-in the cap never
    // converges. Proven live as "13 sessions, zero evictions".
    //
    // Observable signature: the SIGNAL is not sent until the cap
    // resolves. If the hook floated it, the signal (and the function's
    // return) would both land while the eviction was still pending.
    let resolveCap: (v: { evicted: number }) => void = () => {};
    enforceSessionCapForUser.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCap = resolve;
        }),
    );

    const pending = runHook(SESSION);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(signalRevocation).not.toHaveBeenCalled();

    resolveCap({ evicted: 1 });
    await pending;
    expect(signalRevocation).toHaveBeenCalledWith("u1");
  });

  it("never lets a cap failure escape into the sign-in", async () => {
    // `session.create.after` runs outside any try/catch upstream
    // (`with-hooks.mjs` queues it, `transaction.mjs` drains it bare), so
    // a throw here 500s sign-in AFTER the session row has committed.
    enforceSessionCapForUser.mockRejectedValue(new Error("P2034 deadlock"));

    await expect(runHook(SESSION)).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { subsystem: "auth" } }),
    );
  });

  it("AWAITS the stamp, so a serverless freeze cannot drop it", async () => {
    // Same observable signature as the cap: the cap does not start
    // until the stamp resolves. `session-stamp.ts` absorbs its own
    // failures, so this is purely about the await.
    let resolveStamp: (value?: unknown) => void = () => {};
    stampSessionDeviceMetadata.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStamp = resolve as (value?: unknown) => void;
        }),
    );

    const pending = runHook(SESSION);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(enforceSessionCapForUser).not.toHaveBeenCalled();

    resolveStamp();
    await pending;
    expect(enforceSessionCapForUser).toHaveBeenCalled();
  });
});
