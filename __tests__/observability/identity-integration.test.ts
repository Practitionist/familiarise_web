/**
 * @jest-environment node
 */

/**
 * Integration test for the acting-identity plumbing, against the REAL Sentry
 * SDK rather than a mock.
 *
 * Why this file exists separately from `identity.test.ts`: that suite mocks
 * `@sentry/nextjs` and therefore proves the merge *logic* — which keys get
 * written, which get dropped, what happens on an actor change. It cannot prove
 * the three assumptions the whole design rests on, because a mock is
 * configured to agree with them:
 *
 *   1. `Sentry.setUser` REPLACES the user object rather than merging. If this
 *      ever became a merge, `setSentryOrgContext` would stop being dangerous
 *      and `mergeUser`'s care would become cargo cult — or, far worse, the
 *      other way round.
 *   2. `Sentry.setUser` writes to the *isolation* scope, not the process
 *      scope. That is what makes stamping inside a request handler per-request
 *      "by construction" with no AsyncLocalStorage plumbing.
 *   3. Two concurrent `withIsolationScope` blocks do not observe each other.
 *      This is the property that stops a warm Lambda attributing one user's
 *      errors to another, and it is the single most consequential thing in
 *      this subsystem.
 *
 * So this suite asserts on the event the SDK actually builds, captured from
 * `beforeSend`, with every event returned as `null` so nothing is sent. The
 * DSN is synthetic and the transport never fires, so the test is hermetic and
 * consumes no quota.
 */

import * as Sentry from "@sentry/nextjs";

import {
  clearSentryIdentity,
  ORG_ID_TAG,
  setSentryIdentity,
  setSentryOrgContext,
} from "../../lib/observability/identity";
import { reportSentryError } from "../../lib/observability/report";

const SYNTHETIC_DSN =
  "https://0123456789abcdef0123456789abcdef@o0123456789abcdef.ingest.us.sentry.io/0123456789abcdef";

type CapturedEvent = Sentry.Event & { event_id?: string };

const captured: CapturedEvent[] = [];

beforeAll(() => {
  Sentry.init({
    dsn: SYNTHETIC_DSN,
    tracesSampleRate: 0,
    // Nothing here needs the default integrations (global handlers, breadcrumbs,
    // session tracking) and each one is another thing that can log, spawn a
    // timer or reach the network during a unit test.
    defaultIntegrations: false,
    sendClientReports: false,
    environment: "test",
    release: "test@0.0.0",
    /**
     * Returning null is what stops the send. This is the observation point for
     * every assertion below: the event the SDK's full pipeline produced,
     * including the user object and the tags an issue would be searched by.
     */
    beforeSend(event) {
      captured.push(event as CapturedEvent);
      return null;
    },
  });
});

afterAll(async () => {
  await Sentry.flush(0);
  await Sentry.close(0);
});

beforeEach(() => {
  captured.length = 0;
});

/** Capture one event and return it, failing loudly if the SDK produced none. */
async function captureOne(fn: () => void): Promise<CapturedEvent> {
  fn();
  await Sentry.flush(2000);
  expect(captured).toHaveLength(1);
  return captured[0]!;
}

describe("identity reaches the event the SDK actually builds", () => {
  it("puts the user id on the captured event", async () => {
    const event = await captureOne(() =>
      Sentry.withIsolationScope(() => {
        setSentryIdentity({ userId: "usr_int_1", role: "CONSULTANT" });
        reportSentryError(new Error("boom"), { subsystem: "test" });
      }),
    );

    expect(event.user?.id).toBe("usr_int_1");
    // The role is the human-facing label and is deliberately not an email.
    expect(event.user?.username).toBe("CONSULTANT");
    expect(event.user).not.toHaveProperty("email");
  });

  it("tags the event with the org so org_id:<cuid> is searchable", async () => {
    const event = await captureOne(() =>
      Sentry.withIsolationScope(() => {
        setSentryIdentity({ userId: "usr_int_2", role: "STAFF" });
        setSentryOrgContext({
          orgId: "org_int_2",
          orgRole: "OWNER",
          membershipId: "mem_int_2",
        });
        reportSentryError(new Error("boom"), { subsystem: "test" });
      }),
    );

    expect(event.tags?.[ORG_ID_TAG]).toBe("org_int_2");
  });

  it("keeps the user id when the org is stamped afterwards (the real-SDK ordering bug)", async () => {
    const event = await captureOne(() =>
      Sentry.withIsolationScope(() => {
        // Exactly the requireApiAuth → requireOrgAccess order used in the app.
        setSentryIdentity({ userId: "usr_int_3", role: "ADMIN" });
        setSentryOrgContext({ orgId: "org_int_3", orgRole: "ADMIN" });
        reportSentryError(new Error("boom"), { subsystem: "test" });
      }),
    );

    // If the SDK's setUser merged rather than replaced, this assertion would
    // still pass — which is why the dedicated premise test below exists.
    expect(event.user?.id).toBe("usr_int_3");
    expect(event.user?.org_id).toBe("org_int_3");
  });
});

describe("premises the design depends on", () => {
  it("CONFIRMED PREMISE: the real SDK's setUser replaces, it does not merge", async () => {
    const event = await captureOne(() =>
      Sentry.withIsolationScope(() => {
        // Raw SDK calls, deliberately bypassing mergeUser, to observe the
        // platform behaviour the module has to work around.
        Sentry.setUser({ id: "usr_replace_1" });
        Sentry.setUser({ org_id: "org_replace_1" });
        Sentry.captureException(new Error("boom"));
      }),
    );

    // If this ever starts passing with both keys, the SDK changed behaviour
    // and mergeUser's "setUser replaces" rationale is stale — re-read it then.
    expect(event.user?.id).toBeUndefined();
    expect(event.user?.org_id).toBe("org_replace_1");
  });

  it("CONFIRMED PREMISE: setUser writes to the isolation scope, not the process scope", async () => {
    await Sentry.withIsolationScope(async () => {
      setSentryIdentity({ userId: "usr_scope_1", role: "STAFF" });
    });

    // A second, separate scope must not see the first scope's user. If
    // setUser had written to the process scope, this would leak.
    const event = await captureOne(() =>
      Sentry.withIsolationScope(() => {
        Sentry.captureException(new Error("boom"));
      }),
    );

    expect(event.user).toBeFalsy();
  });

  it("CONFIRMED PREMISE: concurrent scopes do not observe each other", async () => {
    /**
     * The property that matters most on a warm Lambda. Both handlers are in
     * flight simultaneously and interleave twice, so a process-scoped write
     * would produce crossed attributes rather than a tidy failure.
     */
    const handler = (userId: string, marker: string) =>
      Sentry.withIsolationScope(async () => {
        setSentryIdentity({ userId, role: marker });
        await new Promise((resolve) => setTimeout(resolve, 0));
        setSentryOrgContext({ orgId: `org_${marker}`, orgRole: marker });
        await new Promise((resolve) => setTimeout(resolve, 0));
        reportSentryError(new Error(`boom-${marker}`), { subsystem: "test" });
      });

    await Promise.all([
      handler("usr_conc_a", "AAA"),
      handler("usr_conc_b", "BBB"),
    ]);
    await Sentry.flush(2000);

    expect(captured).toHaveLength(2);
    const byMarker = new Map(
      captured.map((event) => [
        String(event.exception?.values?.[0]?.value),
        event,
      ]),
    );

    const a = byMarker.get("boom-AAA");
    const b = byMarker.get("boom-BBB");

    expect(a?.user?.id).toBe("usr_conc_a");
    expect(a?.user?.org_id).toBe("org_AAA");
    expect(a?.tags?.[ORG_ID_TAG]).toBe("org_AAA");

    expect(b?.user?.id).toBe("usr_conc_b");
    expect(b?.user?.org_id).toBe("org_BBB");
    expect(b?.tags?.[ORG_ID_TAG]).toBe("org_BBB");
  });
});

describe("actor lifecycle", () => {
  it("a signed-out scope reports no identifying user", async () => {
    const event = await captureOne(() =>
      Sentry.withIsolationScope(() => {
        setSentryIdentity({ userId: "usr_before_out", role: "STAFF" });
        setSentryOrgContext({ orgId: "org_before_out", orgRole: "OWNER" });
        clearSentryIdentity();
        reportSentryError(new Error("boom"), { subsystem: "test" });
      }),
    );

    // What `clearSentryIdentity` guarantees is that no identifying value
    // survives, and that holds.
    expect(event.user?.id).toBeUndefined();
    expect(event.user?.username).toBeUndefined();
    expect(event.user?.email).toBeUndefined();
    expect(event.user?.ip_address).toBeUndefined();
    expect(event.tags?.[ORG_ID_TAG]).toBe("");
  });

  it("KNOWN ASYMMETRY: a cleared scope is not in the same state as a never-stamped one", async () => {
    const cleared = await captureOne(() =>
      Sentry.withIsolationScope(() => {
        setSentryIdentity({ userId: "usr_asym", role: "STAFF" });
        clearSentryIdentity();
        reportSentryError(new Error("boom"), { subsystem: "test" });
      }),
    );
    captured.length = 0;
    const never = await captureOne(() =>
      Sentry.withIsolationScope(() => {
        reportSentryError(new Error("boom"), { subsystem: "test" });
      }),
    );

    // Pinned deliberately. `Sentry.setUser(null)` leaves the `user` key
    // PRESENT, holding exactly the four fields ACTOR_IDENTITY_KEYS names, every
    // one of them `undefined` — whereas a scope that was never stamped has no
    // `user` key at all. (Do not check this by JSON-serialising the event:
    // `JSON.stringify` drops undefined values and makes it look like `{}`.)
    // No identifier survives either way, so neither shape is a privacy
    // problem, but they are not the same event — it is the same "there is no
    // unset API" asymmetry the module already works around for ORG_ID_TAG
    // with an empty string. Whether Sentry's "Users affected" counter counts
    // an all-undefined user object is NOT verified here; that needs ingest.
    // If it does, the fix is a dedicated reset, not a looser assertion.
    expect(Object.keys(cleared.user ?? {}).sort()).toEqual([
      "email",
      "id",
      "ip_address",
      "username",
    ]);
    expect(
      Object.values(cleared.user as object).every((v) => v === undefined),
    ).toBe(true);
    expect(never.user).toBeUndefined();
  });

  it("a different actor cannot inherit the previous one's org", async () => {
    const event = await captureOne(() =>
      Sentry.withIsolationScope(() => {
        setSentryIdentity({ userId: "usr_actor_a", role: "STAFF" });
        setSentryOrgContext({ orgId: "org_actor_a", orgRole: "OWNER" });
        // Same scope, different actor — the swap a session change performs.
        setSentryIdentity({ userId: "usr_actor_b", role: "CONSULTANT" });
        reportSentryError(new Error("boom"), { subsystem: "test" });
      }),
    );

    expect(event.user?.id).toBe("usr_actor_b");
    expect(event.user?.org_id).toBeUndefined();
    expect(event.tags?.[ORG_ID_TAG]).toBe("");
  });
});

describe("the paths with no identity, stated rather than implied", () => {
  it("an unstamped scope produces an event with no user — this is the Users: 0 case", async () => {
    // Cron jobs, scheduleAfter continuations and webhooks all land here. The
    // audit found 38 of 40 unresolved issues at Users: 0, so it is worth
    // pinning the real shape of the unattributed event rather than leaving it
    // implied: it is not a failure, it is a known, expected category.
    const event = await captureOne(() =>
      Sentry.withIsolationScope(() => {
        reportSentryError(new Error("boom"), { subsystem: "test" });
      }),
    );

    expect(event.user).toBeFalsy();
    // The event is still fully reportable — the absence of a user degrades
    // attribution, not the event.
    expect(event.exception?.values?.[0]?.value).toBe("boom");
  });
});
