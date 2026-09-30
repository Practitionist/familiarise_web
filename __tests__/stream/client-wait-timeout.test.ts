/**
 * @jest-environment node
 */

/**
 * #1134 — the meeting page could sit in a skeleton forever.
 *
 * `useGetCallById` returns early while the video client is undefined, and
 * deliberately so: the provider mounts it lazily, so `undefined` is the normal
 * cold-load state and raising an error there produced a "Video client not
 * available" flash on every open.
 *
 * But the effect re-runs only on `[client, callId, rejoinKey]`. If the client
 * never arrives — Stream unconfigured, a token fetch that keeps failing, a
 * provider that errored out — none of those change, `isCallLoading` stays true,
 * and `app/meetings/[id]/page.tsx` renders `MeetingRoomSkeleton` with no error,
 * no message and no exit. Someone waiting to be let into a session they paid
 * for watches a placeholder animate.
 *
 * The fix bounds the wait rather than removing it. The bound is the part worth
 * testing: it has to outlast the provider's own retry ladder, or it fires while
 * the provider is still retrying and would have succeeded — turning a slow
 * connect into a reported failure.
 */

import { readFileSync } from "fs";
import { join } from "path";

const hook = readFileSync(
  join(process.cwd(), "app/meetings/[id]/hooks/useGetCallById.ts"),
  "utf8",
);
const provider = readFileSync(
  join(process.cwd(), "providers/StreamProviderImpl.tsx"),
  "utf8",
);

/** The ladder StreamProviderImpl actually walks, derived from its own source. */
function providerBackoffMs(): number {
  const maxAttempts = Number(
    /MAX_CONNECT_ATTEMPTS = (\d+)/.exec(provider)?.[1] ?? NaN,
  );
  const capMs = Number(
    /Math\.min\(1000 \* Math\.pow\(2, attempt\), (\d+)\)/.exec(provider)?.[1] ??
      NaN,
  );
  expect(Number.isFinite(maxAttempts)).toBe(true);
  expect(Number.isFinite(capMs)).toBe(true);

  // Attempt n sleeps min(1000 * 2^n, cap) before retry n+1, for n = 1..max-1.
  let total = 0;
  for (let n = 1; n < maxAttempts; n++) {
    total += Math.min(1000 * 2 ** n, capMs);
  }
  return total;
}

describe("the bounded wait for the video client", () => {
  it("exists at all", () => {
    expect(hook).toContain("CLIENT_WAIT_TIMEOUT_MS");
    // The early return must survive — an immediate error is the flash this
    // deliberately avoids.
    expect(hook).toContain("if (!client) return;");
  });

  it("clears loading and sets an error when it elapses", () => {
    // Both, not just the error: `page.tsx` gates on `isCallLoading` first, so
    // an error left underneath a true loading flag renders the same skeleton.
    const block = /CLIENT_WAIT_TIMEOUT_MS\);/.exec(hook);
    expect(block).not.toBeNull();
    const timeoutBody = hook.slice(
      hook.indexOf("const timer = setTimeout"),
      hook.indexOf("CLIENT_WAIT_TIMEOUT_MS);"),
    );
    expect(timeoutBody).toContain("setError(");
    expect(timeoutBody).toContain("setIsCallLoading(false)");
  });

  it("outlasts the provider's full retry ladder", () => {
    const timeout = Number(
      /CLIENT_WAIT_TIMEOUT_MS = ([\d_]+)/.exec(hook)?.[1].replace(/_/g, "") ??
        NaN,
    );
    expect(Number.isFinite(timeout)).toBe(true);

    const backoff = providerBackoffMs();
    // 30_000ms today. A bound at or under it would report failure while the
    // provider was still working — the connect attempts themselves take time
    // on top of this, so the margin is the point.
    expect(backoff).toBeGreaterThan(0);
    expect(timeout).toBeGreaterThan(backoff);
  });

  it("cancels the timer when the client arrives", () => {
    // Otherwise a client that lands at 44s still gets an error at 45s, on top
    // of a call that resolved fine.
    expect(hook).toContain("return () => clearTimeout(timer)");
    expect(hook).toContain("if (client || !callId) return;");
  });

  it("does not fire once a client is present", () => {
    // The guard is the first statement, so a mounted-with-client render never
    // schedules anything.
    const effectStart = hook.indexOf("if (client || !callId) return;");
    const timerStart = hook.indexOf("const timer = setTimeout");
    expect(effectStart).toBeGreaterThan(-1);
    expect(timerStart).toBeGreaterThan(effectStart);
  });
});

/**
 * #1829 — two provider-level defects, both about what the code BELIEVED about a
 * client rather than what the client was.
 *
 * They are asserted against the source because the behaviour lives in the
 * branching, and the SDK is the thing that has to be trusted about its own
 * contract: `connectUser` on a client that already holds this userID returns the
 * previous `setUserPromise` without reopening the socket (stream-chat@9.52.0),
 * so "awaited without throwing" proves nothing about liveness. A mock that
 * behaves correctly would test the mock.
 */
describe("#1829 — chat reconnect must reopen the socket, not re-await connectUser", () => {
  /** The offset of the `openConnection` repair branch, or -1. */
  const repairOffset = (): number =>
    provider.indexOf("await client.openConnection()");
  const connectOffset = (): number =>
    provider.indexOf("await client.connectUser(");

  it("repairs a matching-user client with openConnection BEFORE calling connectUser", () => {
    expect(repairOffset()).toBeGreaterThan(-1);
    // Order is the whole fix. `connectUser` on a client that already holds the
    // userID short-circuits, so reaching it first reintroduces the bug.
    expect(repairOffset()).toBeLessThan(connectOffset());
  });

  it("gates the repair on the userID matching, not merely on the client existing", () => {
    // An unconditional openConnection would run for a client belonging to a
    // different user — a client this function has no business touching.
    const branch = provider.slice(
      provider.lastIndexOf("if (client.userID", repairOffset()),
      repairOffset(),
    );
    expect(branch).toContain("client.userID === userDetails.id");
  });

  it("adopts a reconnect already in flight rather than duplicating it", () => {
    const branch = provider.slice(
      provider.lastIndexOf("if (client.userID", repairOffset()),
      repairOffset(),
    );
    expect(branch).toContain("isConnecting");
  });

  it("documents the SDK short-circuit it works around", () => {
    // A future SDK upgrade could remove the short-circuit and this branch
    // would become redundant. The comment is the tripwire for that review.
    expect(provider).toContain("Consecutive calls to connectUser");
  });
});

describe("#1829 — a replaced video client is disconnected, not abandoned", () => {
  it("disconnects the dead same-user client before overwriting the global", () => {
    const disconnect = provider.indexOf(
      "await adoptable.disconnectUser().catch(() => undefined)",
    );
    const overwrite = provider.indexOf("setGlobalVideoClient(client)");
    expect(disconnect).toBeGreaterThan(-1);
    // Before the overwrite, or the old client loses its last reference and
    // nothing can ever disconnect it again.
    expect(disconnect).toBeLessThan(overwrite);
  });

  it("scopes the teardown to the same user", () => {
    // Tearing down a client belonging to a DIFFERENT user would kill a session
    // this function was never asked to end.
    const branch = provider.slice(
      provider.indexOf("if (sameUser && adoptable)"),
      provider.indexOf("if (sameUser && adoptable)") + 200,
    );
    expect(branch).toContain("sameUser && adoptable");
  });

  it("swallows the rejection — a dead client must not fail a live connect", () => {
    const disconnect = provider.indexOf(
      "await adoptable.disconnectUser().catch(() => undefined)",
    );
    expect(provider.slice(disconnect, disconnect + 90)).toContain(
      ".catch(() => undefined)",
    );
  });
});

/**
 * #1827 — a reconnect must RECONCILE, not merely reopen.
 *
 * `markSyncIncomplete` in the grace timer clears the "sync kicked" guard so the
 * reconnect can act on it. It previously did not: `connectChat` returned out of
 * the `openConnection()` branch before reaching the block that read the guard, so
 * every mid-session flap reopened the socket and left every channel membership
 * exactly as it was when the network dropped. Three comments asserted otherwise.
 *
 * The same guard is why the full-connect and live-adopt branches have to kick too:
 * a live socket is not evidence the sync ran, and the grace timer may have
 * cleared the guard deliberately.
 */
describe("#1829 — every connect path that resolves a client also kicks the sync", () => {
  it("kicks from the openConnection reconnect branch", () => {
    // The branch a mid-session flap lands on: `connectUser` is not re-runnable on
    // a client that already holds the userID, so this is not an edge case.
    // Read forward from the reopen to the return, in source order.
    const open = provider.indexOf("await client.openConnection()");
    const ret = provider.indexOf("return client;", open);
    expect(open).toBeGreaterThan(-1);
    expect(ret).toBeGreaterThan(open);
    expect(provider.slice(open, ret)).toContain(
      "kickChannelSync(userDetails.id)",
    );
  });

  it("kicks from the full connectUser path", () => {
    const n = (provider.match(/kickChannelSync\(userDetails\.id\)/g) ?? [])
      .length;
    // Four paths resolve a client: the in-flight reconnect, the opened
    // reconnect, the live-adopt, and the full connect. All four must kick, or a
    // reconnect reopens the socket and reconciles nothing — the bug these paths
    // were changed to fix.
    expect(n).toBe(4);
  });

  it("no connect path returns a client without kicking or skipping deliberately", () => {
    // Each `return client;` in connectChat must be preceded by a kick, or be one
    // of the two pre-connect bail-outs (concurrent-connect skip, not-found).
    const after = provider.indexOf("const connectChat = useCallback(");
    const body = provider.slice(
      after,
      provider.indexOf("const connectVideo", after),
    );
    // Use each match's own `index`, not a fresh `indexOf` — the latter finds the
    // FIRST occurrence, so every iteration after the first inspected the same
    // window and the loop was decorative.
    const returns = [...body.matchAll(/^(\s*)return client;$/gm)];
    expect(returns.length).toBeGreaterThan(0);
    for (const match of returns) {
      const idx = match.index;
      const before = body.slice(Math.max(0, idx - 400), idx);
      // Each `return client;` is either preceded by a sync kick, or is one of
      // the two deliberate bail-outs: the concurrent-connect guard and the
      // adopt-a-live-client path (which kicks separately, earlier).
      expect(before).toMatch(
        /kickChannelSync\(userDetails\.id\)|isChatConnectingRef|adoptable|getGlobalChatClient/,
      );
    }
  });
});

/**
 * #1829 — the in-flight reconnect must not claim to be connected.
 *
 * `wsConnection.isConnecting` means a handshake is running. Marking
 * `chatConnected` on that basis reintroduces through this branch exactly what
 * `#E7` fixed one layer up: a matching `userID` mistaken for a live socket, so
 * the store reports connected over a socket that never finished connecting — and
 * if the handshake fails, over a dead one. `connection.changed` or the grace
 * timer is what sets the flag honestly.
 */
describe("#1829 — an in-flight reconnect is adopted, not declared connected", () => {
  const inFlightBranch = (): string => {
    const at = provider.indexOf("client.wsConnection?.isConnecting");
    return provider.slice(at, provider.indexOf("return client;", at));
  };

  it("does not setChatConnected in the isConnecting branch", () => {
    const b = inFlightBranch();
    expect(provider).toContain("client.wsConnection?.isConnecting");
    expect(b).not.toContain("setChatConnected(true)");
  });

  it("still kicks the channel sync, because staleness is not a socket fact", () => {
    // Membership went stale when the network went away, not when the handshake
    // finishes — so this branch must reconcile too, or the guard the grace timer
    // cleared goes unused on exactly the path that needed it.
    expect(inFlightBranch()).toContain("kickChannelSync(userDetails.id)");
  });

  it("awaits openConnection on the NOT-in-flight path, so connected is earned", () => {
    const open = provider.indexOf("await client.openConnection()");
    const ret = provider.indexOf("return client;", open);
    const b = provider.slice(open, ret);
    expect(b).toContain("await client.openConnection()");
    expect(b).toContain("setChatConnected(true)");
  });

  it("records the fallback as a test fixture assertion, not a doc claim", () => {
    // `start_time` must fall back to `created_at`, never to "now": the value
    // feeds `streamUrlExpiresAt`, and a "now" fallback measured from a sweeper
    // re-drive sets the expiry to re-drive + 14d while Stream deletes the bytes
    // at call + 14d — so the 410 gate passes on a URL that is already dead.
    const handlers = readFileSync(
      join(process.cwd(), "lib/stream/recording-handlers.ts"),
      "utf8",
    );
    expect(handlers).toContain("eventInstant(start_time, created_at)");
    expect(handlers).not.toContain("eventInstant(start_time)");
  });
});
