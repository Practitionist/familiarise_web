/**
 * @jest-environment node
 */

/**
 * The canary's alert cooldown.
 *
 * Without it the canary emails the same content on every failing run — at the
 * 30-minute cadence that is 48 identical emails a day, and an alert nobody
 * reads is the same as no alert. The canary exists because six days of dead
 * error ingestion went unnoticed; an alert that trains people to ignore it
 * reintroduces that outcome through the front door.
 *
 * The store is injected, so none of this touches Redis.
 */

import {
  CANARY_ALERT_KEY,
  CANARY_ALERT_REASSERT_MS,
  type AlertStateStore,
  canaryAlertNeeded,
  recordCanaryAlertSent,
} from "../../lib/observability/ingest-alert";

/** A store that holds one value in memory, standing in for Redis. */
function fakeStore(initial: string | null = null) {
  let value = initial;
  const writes: Array<{ value: string; ttlMs: number }> = [];
  const store: AlertStateStore = {
    async get() {
      return value;
    },
    async set(v, ttlMs) {
      value = v;
      writes.push({ value: v, ttlMs });
    },
  };
  return { store, writes, peek: () => value };
}

describe("one email per distinct state", () => {
  it("sends the first time it sees a verdict, without arming anything yet", async () => {
    const { store, writes } = fakeStore();
    await expect(canaryAlertNeeded("rate-limited", store)).resolves.toBe(true);
    // The read phase must be side-effect free: arming belongs to the send.
    expect(writes).toHaveLength(0);
  });

  it("suppresses the same verdict on the next run", async () => {
    const { store } = fakeStore("rate-limited");
    await expect(canaryAlertNeeded("rate-limited", store)).resolves.toBe(false);
  });

  it("sends IMMEDIATELY when the verdict changes — that is new information", async () => {
    const { store, peek } = fakeStore("rate-limited");
    // rate-limited → rejected-auth means the operator's action differs
    // completely, so waiting for the daily re-assert would be wrong.
    await expect(canaryAlertNeeded("rejected-auth", store)).resolves.toBe(true);
    // and the cooldown then tracks the NEW verdict, so the old one is free to
    // recur and alert again if ingest flips back.
    await recordCanaryAlertSent("rejected-auth", store);
    expect(peek()).toBe("rejected-auth");
  });

  it("treats every verdict as its own state, not a shared bucket", async () => {
    const verdicts = [
      "accepted",
      "dropped-despite-2xx",
      "rate-limited",
      "rejected-auth",
      "unavailable",
    ];
    for (const v of verdicts) {
      const { store } = fakeStore();
      await expect(canaryAlertNeeded(v, store)).resolves.toBe(true);
    }
  });

  it("collapses 48 runs of a 30-minute cron into one email", async () => {
    // The actual problem being fixed, run through the real two-phase flow.
    const { store, writes } = fakeStore();
    let sends = 0;
    for (let run = 0; run < 48; run++) {
      if (await canaryAlertNeeded("rate-limited", store)) {
        sends++;
        await recordCanaryAlertSent("rate-limited", store);
      }
    }
    expect(sends).toBe(1);
    expect(writes).toHaveLength(1);
  });
});

describe("an ongoing outage is not forgotten", () => {
  it("re-asserts once the window expires, so a week-long outage still surfaces", async () => {
    // Simulates the store having expired (get returns null), which is what the
    // TTL produces 24h later.
    const { store } = fakeStore(null);
    await expect(canaryAlertNeeded("rate-limited", store)).resolves.toBe(true);
  });

  it("arms the window with the TTL so Redis expires it without a sweeper", async () => {
    const { store, writes } = fakeStore();
    await canaryAlertNeeded("unavailable", store);
    await recordCanaryAlertSent("unavailable", store);
    expect(writes[0]).toEqual({
      value: "unavailable",
      ttlMs: CANARY_ALERT_REASSERT_MS,
    });
  });

  it("uses a 24h window, not a short one", () => {
    // A short window turns a sustained outage back into the 48-a-day spam.
    expect(CANARY_ALERT_REASSERT_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("keys it under its own namespace", () => {
    // Must not collide with the cron locks or any other Redis key.
    expect(CANARY_ALERT_KEY).toBe("observability:canary:last-alerted-verdict");
  });
});

describe("a failed send must not silence the next run", () => {
  /**
   * Regression. The gate used to read the state AND write the new verdict in
   * one step, before the send was attempted. So a single failed delivery — the
   * email provider down — armed a 24-hour suppression for a verdict nobody had
   * been told about, and the canary went quiet about broken ingest for a day.
   * That is the exact failure this mechanism exists to prevent, reached by the
   * alerting itself.
   */
  it("does not arm the cooldown when the alert was never sent", async () => {
    const { store, peek } = fakeStore();

    // Run 1: needed, then the send FAILS, so nothing is recorded.
    expect(await canaryAlertNeeded("rate-limited", store)).toBe(true);
    // ... `alerted === false`, so `recordCanaryAlertSent` is not called.
    expect(peek()).toBeNull();

    // Run 2, 30 minutes later: still needed. The failure was retried.
    expect(await canaryAlertNeeded("rate-limited", store)).toBe(true);
  });

  it("does arm it once a send succeeds", async () => {
    const { store, peek } = fakeStore();
    expect(await canaryAlertNeeded("rate-limited", store)).toBe(true);
    await recordCanaryAlertSent("rate-limited", store);
    expect(peek()).toBe("rate-limited");
    expect(await canaryAlertNeeded("rate-limited", store)).toBe(false);
  });

  it("a cooldown write that fails does not block the send that already went out", async () => {
    const store: AlertStateStore = {
      async get() {
        return null;
      },
      async set() {
        throw new Error("READONLY");
      },
    };
    expect(await canaryAlertNeeded("rate-limited", store)).toBe(true);
    // The alert was already delivered; arming must not throw or report failure
    // in a way that would make the caller think it was not.
    await expect(
      recordCanaryAlertSent("rate-limited", store),
    ).resolves.toBeUndefined();
    // Cost of this failure mode is one duplicate email on the next run.
    expect(await canaryAlertNeeded("rate-limited", store)).toBe(true);
  });
});

describe("it fails OPEN, and that is the whole point", () => {
  it("sends when the store cannot be read", async () => {
    const store: AlertStateStore = {
      async get() {
        throw new Error("ECONNRESET");
      },
      async set() {},
    };
    await expect(canaryAlertNeeded("rate-limited", store)).resolves.toBe(true);
  });

  it("sends when the store cannot be written", async () => {
    const store: AlertStateStore = {
      async get() {
        return "something-else";
      },
      async set() {
        throw new Error("READONLY");
      },
    };
    await expect(canaryAlertNeeded("rate-limited", store)).resolves.toBe(true);
  });

  it("never throws, whatever the store does", async () => {
    const store: AlertStateStore = {
      async get() {
        throw new Error("boom");
      },
      async set() {
        throw new Error("boom");
      },
    };
    await expect(canaryAlertNeeded("rate-limited", store)).resolves.toBe(true);
  });

  it("does not swallow the store's own error silently", async () => {
    // Fail-open is only safe if the operator can still see that suppression is
    // not working, or the gate degrades to off with nobody noticing.
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const store: AlertStateStore = {
      async get() {
        throw new Error("ECONNRESET");
      },
      async set() {},
    };
    await canaryAlertNeeded("rate-limited", store);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("alert state unavailable"),
      "ECONNRESET",
    );
    spy.mockRestore();
  });
});
