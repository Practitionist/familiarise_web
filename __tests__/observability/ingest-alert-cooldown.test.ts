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
  shouldSendCanaryAlert,
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
  it("sends the first time it sees a verdict", async () => {
    const { store, peek } = fakeStore();
    await expect(shouldSendCanaryAlert("rate-limited", store)).resolves.toBe(
      true,
    );
    expect(peek()).toBe("rate-limited");
  });

  it("suppresses the same verdict on the next run", async () => {
    const { store } = fakeStore("rate-limited");
    await expect(shouldSendCanaryAlert("rate-limited", store)).resolves.toBe(
      false,
    );
  });

  it("sends IMMEDIATELY when the verdict changes — that is new information", async () => {
    const { store, peek } = fakeStore("rate-limited");
    // rate-limited → rejected-auth means the operator's action differs
    // completely, so waiting for the daily re-assert would be wrong.
    await expect(shouldSendCanaryAlert("rejected-auth", store)).resolves.toBe(
      true,
    );
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
      await expect(shouldSendCanaryAlert(v, store)).resolves.toBe(true);
    }
  });

  it("collapses 48 runs of a 30-minute cron into one email", async () => {
    // The actual problem being fixed.
    const { store, writes } = fakeStore();
    let sends = 0;
    for (let run = 0; run < 48; run++) {
      if (await shouldSendCanaryAlert("rate-limited", store)) sends++;
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
    await expect(shouldSendCanaryAlert("rate-limited", store)).resolves.toBe(
      true,
    );
  });

  it("uses a 24h window, not a short one", () => {
    // A short window turns a sustained outage back into the 48-a-day spam.
    expect(CANARY_ALERT_REASSERT_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("writes the window as the TTL so Redis expires it without a sweeper", () => {
    const { store, writes } = fakeStore();
    return shouldSendCanaryAlert("unavailable", store).then(() => {
      expect(writes[0]).toEqual({
        value: "unavailable",
        ttlMs: CANARY_ALERT_REASSERT_MS,
      });
    });
  });

  it("keys it under its own namespace", () => {
    // Must not collide with the cron locks or any other Redis key.
    expect(CANARY_ALERT_KEY).toBe("observability:canary:last-alerted-verdict");
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
    await expect(shouldSendCanaryAlert("rate-limited", store)).resolves.toBe(
      true,
    );
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
    await expect(shouldSendCanaryAlert("rate-limited", store)).resolves.toBe(
      true,
    );
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
    await expect(shouldSendCanaryAlert("rate-limited", store)).resolves.toBe(
      true,
    );
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
    await shouldSendCanaryAlert("rate-limited", store);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("alert state unavailable"),
      "ECONNRESET",
    );
    spy.mockRestore();
  });
});
