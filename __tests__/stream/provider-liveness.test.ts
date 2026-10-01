/**
 * @jest-environment node
 */

/**
 * #1829 — the provider's two liveness helpers read properties stream-chat does
 * not have, and one of them read IDENTITY instead of transport health.
 *
 * Both were P1s in the same direction: each returned `true` (or, for chat,
 * could only ever return `false`) for a state the SDK does not actually have,
 * so the provider's retry/adopt decisions were made on a fiction while the
 * test suite stayed green — because the fixtures were built to match the
 * fiction. A mock carrying `connected: true` is exactly the thing that made
 * the original defect invisible, so it is banned here: every fixture below is
 * assembled from the fields the installed SDKs actually declare, and each
 * one's provenance is cited.
 *
 * `isChatClientLive` read `wsConnection.connected`. `StableWSConnection` has no
 * such member (stream-chat@9.52.0,
 * `node_modules/stream-chat/dist/types/connection.d.ts:21-44`), so the read was
 * ALWAYS false against a real client: a healthy socket was rejected and recovery
 * ran in its place.
 *
 * `isVideoClientLive` read `state.connectedUser`, which the video SDK clears only
 * in `connectUser`/`disconnectUser` (@stream-io/video-client@1.59.0,
 * `dist/index.cjs.js:20026` and `:20051`) and NOT on a dropped socket — so a
 * video-only outage was adopted and published as `videoConnected: true`.
 */

// The module graph is mocked because these helpers are pure property reads: the
// provider module is imported for its CODE, and pulling the real server actions
// and SDKs in would add nothing but prisma and an ESM auth library to the
// process. The helpers themselves are unmocked and are what the assertions
// below call.
//
// Mock paths are relative, not `@/…`: `next/jest` has the bundler rewrite the
// provider's `@/…` specifiers to real paths, so a mock registered under the
// alias would never match.
jest.mock("stream-chat", () => ({
  StreamChat: { getInstance: () => ({}) },
}));
jest.mock("@stream-io/video-react-sdk", () => ({
  StreamVideoClient: class {},
}));
jest.mock("../../actions/stream/chat/stream.action", () => ({
  chatTokenProvider: jest.fn(),
  tokenProvider: jest.fn(),
}));
jest.mock("../../actions/stream/chat/user.action", () => ({
  upsertUserToStream: jest.fn(),
}));
jest.mock("../../actions/stream/chat/event-channel.action", () => ({
  syncUserEventChannels: jest.fn(),
}));
jest.mock("../../hooks/useUserData", () => ({ useUserData: jest.fn() }));
jest.mock("../../lib/auth-client", () => ({ useSession: jest.fn() }));
jest.mock("../../components/stream/StreamInitialTokens", () => ({
  useStreamInitialTokens: jest.fn(),
}));

import { readFileSync } from "fs";
import { join } from "path";

import {
  isChatClientLive,
  isVideoClientLive,
} from "../../providers/StreamProviderImpl";

const provider = readFileSync(
  join(process.cwd(), "providers/StreamProviderImpl.tsx"),
  "utf8",
);

/* -------------------------------------------------------------------------- */
/* Fixtures — real SDK shapes, every field cited                            */
/* -------------------------------------------------------------------------- */

/**
 * The fixture types are DERIVED from the helpers' own signatures, which are
 * themselves derived from the installed SDKs with `Pick`. So a field name here
 * is checked against the SDK's declared types rather than merely agreeing with
 * whatever the body happens to read — which is precisely the gap that let
 * `connected` (a field no SDK client has) sit in a fixture and pass.
 *
 * No `as unknown as StreamChat` anywhere below: a cast would re-open the exact
 * hole this file closes.
 */
type LivenessChat = Parameters<typeof isChatClientLive>[0];
type LivenessVideo = Parameters<typeof isVideoClientLive>[0];

/**
 * A `StableWSConnection` for the APP's chat client, built from
 * `stream-chat@9.52.0 dist/types/connection.d.ts:21-44`. Note what is NOT here:
 * `connected`. There is no such member, which is the whole defect.
 */
type WsFixture = NonNullable<LivenessChat["wsConnection"]> & {
  isConnecting: boolean;
  isDisconnected: boolean;
  consecutiveFailures: number;
};

function wsConnection(over: Partial<WsFixture> = {}): WsFixture {
  return {
    connectionID: "conn-1",
    isHealthy: true,
    isConnecting: false,
    isDisconnected: false,
    consecutiveFailures: 0,
    ...over,
  };
}

/**
 * A `WSConnectionFallback` from `stream-chat@9.52.0
 * dist/types/connection_fallback.d.ts:11-40`. Its `isHealthy` is a METHOD, and
 * the shipped implementation (`dist/cjs/index.browser.js:12478`) is
 * `!!this.connectionID && this.state === "CONNECTED"`.
 *
 * `state` is kept as a plain string and folded into the transcribed body rather
 * than typed as `ConnectionState`, because that enum is not exported from the
 * package root and a hand-rolled copy of it would be a second source of truth.
 */
type FallbackFixture = NonNullable<LivenessChat["wsFallback"]>;

function wsFallback(state = "CONNECTED"): FallbackFixture {
  const connectionID = "fallback-1";
  return {
    connectionID,
    // The real body, transcribed — not a `jest.fn()` returning whatever the test
    // wanted, which is how these fixtures lie in the first place.
    isHealthy: () => !!connectionID && state === "CONNECTED",
  };
}

/**
 * The parts of `StreamChat` the helper may read. `_hasConnectionID` is on the
 * published type (`dist/types/client.d.ts:172`) and is implemented as
 * `Boolean(this._getConnectionID())` where `_getConnectionID` is
 * `this.wsConnection?.connectionID || this.wsFallback?.connectionID`
 * (`dist/cjs/index.browser.js:14585-14586`) — so this transcription is the SDK's.
 */
type ChatFixture = LivenessChat;

function chatClient(over: Partial<ChatFixture> = {}): ChatFixture {
  const ws =
    over.wsConnection === undefined ? wsConnection() : over.wsConnection;
  const fallback = over.wsFallback;
  return {
    wsConnection: ws,
    ...(fallback ? { wsFallback: fallback } : {}),
    _hasConnectionID: () => Boolean(ws?.connectionID ?? fallback?.connectionID),
  };
}

/**
 * The video SDK's coordinator client. `StreamVideoClient.streamClient` is a
 * `StreamClient` (`@stream-io/video-client@1.59.0
 * dist/src/StreamVideoClient.d.ts:24`), whose `wsConnection` is a
 * `StableWSConnection` of the video SDK's OWN vendored copy
 * (`dist/src/coordinator/connection/client.d.ts:28`), and whose
 * `_hasConnectionID` is `Boolean(this.wsConnection?.connectionID)`
 * (`dist/index.cjs.js:18708-18709`). There is NO `wsFallback` on this class — the
 * video SDK vendors no long-poll fallback at all.
 */
type VideoFixture = LivenessVideo & {
  /**
   * `StreamVideoReadOnlyStateStore` (`dist/src/StreamVideoClient.d.ts:46`).
   * Carried on the fixture — and deliberately ABSENT from the helper's
   * parameter type — so these tests can prove identity is ignored rather than
   * merely unreferenced.
   */
  state: { connectedUser?: { id: string } };
};

function videoClient(
  over: {
    /** Whether the coordinator socket is up. */
    healthy?: boolean;
    connecting?: boolean;
    /**
     * Whether `state.connectedUser` is still populated. Left ON by default on
     * purpose: the defect was that a dropped socket did NOT clear it, so the
     * interesting fixture is the one where identity survives and transport does
     * not.
     */
    identityPresent?: boolean;
  } = {},
): VideoFixture {
  const healthy = over.healthy ?? true;
  const ws = wsConnection({
    isHealthy: healthy,
    isConnecting: over.connecting ?? false,
    isDisconnected: !healthy,
  });
  return {
    state:
      over.identityPresent === false ? {} : { connectedUser: { id: "u1" } },
    streamClient: {
      wsConnection: ws,
      _hasConnectionID: () => Boolean(ws.connectionID),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Defect 1 — chat: the SDK's own health composition, not an invented field  */
/* -------------------------------------------------------------------------- */

describe("#1829 isChatClientLive reads the SDK's real health fields", () => {
  it("reports a healthy WebSocket as live", () => {
    // The regression this whole file exists for: pre-fix this read
    // `wsConnection.connected`, which no SDK client has, so a perfectly healthy
    // client read as DEAD and the provider needlessly ran recovery.
    expect(isChatClientLive(chatClient())).toBe(true);
  });

  it("reports a healthy long-poll FALLBACK as live", () => {
    // `wsFallback.isHealthy()` is the second term of the SDK's own composition
    // (`dist/cjs/index.browser.js:14718`). Pre-fix there was no fallback term at
    // all, so a client whose WS was unusable but whose long-poll connection was
    // up read as dead.
    expect(
      isChatClientLive(
        chatClient({ wsConnection: null, wsFallback: wsFallback() }),
      ),
    ).toBe(true);
  });

  it("treats a CONNECTING socket as not live", () => {
    // A handshake in flight is not a connection. The retry decision must run,
    // and the caller must not claim readiness — `connectChat` handles the
    // in-flight case on its own `isConnecting` branch.
    const connecting = wsConnection({ isHealthy: false, isConnecting: true });
    expect(isChatClientLive(chatClient({ wsConnection: connecting }))).toBe(
      false,
    );
  });

  it("treats a DISCONNECTED / offline socket as not live", () => {
    expect(
      isChatClientLive(
        chatClient({
          wsConnection: wsConnection({
            isHealthy: false,
            isDisconnected: true,
            consecutiveFailures: 4,
          }),
        }),
      ),
    ).toBe(false);
  });

  it("treats a closed fallback as not live", () => {
    expect(
      isChatClientLive(
        chatClient({
          wsConnection: null,
          wsFallback: wsFallback("CLOSED"),
        }),
      ),
    ).toBe(false);
  });

  it("treats a client with no connection at all as not live (fail closed)", () => {
    // An unknown socket state must send us through a real connect; the cost of
    // guessing "live" is the bug #E7 exists to fix.
    expect(isChatClientLive(chatClient({ wsConnection: null }))).toBe(false);
    expect(
      isChatClientLive(
        chatClient({ wsConnection: null, wsFallback: undefined }),
      ),
    ).toBe(false);
  });

  it("refuses a healthy socket that has no connectionID", () => {
    // The SDK's composition is health AND a connectionID
    // (`index.browser.js:14718`) — health alone is not proof the session is
    // usable, and `openConnection` would refuse it too.
    expect(
      isChatClientLive(
        chatClient({
          wsConnection: wsConnection({ connectionID: undefined }),
        }),
      ),
    ).toBe(false);
  });

  it("ignores a `.connected` property, which is what made the old suite green", () => {
    // The forbidden mock, asserted as a fixture rather than described in a
    // comment. A `connected: true` on the connection object is what the original
    // suite carried, and it is exactly why that suite passed while production
    // took the opposite branch on every real client. This shape must NOT be what
    // the helper reads: the socket here is dead (not healthy, no connectionID)
    // and the extra property has to change nothing.
    const poisoned: WsFixture & { connected: boolean } = {
      ...wsConnection({ isHealthy: false, connectionID: undefined }),
      connected: true,
    };
    expect(isChatClientLive(chatClient({ wsConnection: poisoned }))).toBe(
      false,
    );
  });

  it("reads no property the SDK does not declare", () => {
    // The tripwire. If a future edit reaches for another invented field this
    // fails even if every fixture above happens to pass.
    const body = provider.slice(
      provider.indexOf("export function isChatClientLive("),
      provider.indexOf("export function isVideoClientLive("),
    );
    expect(body).not.toMatch(/\.connected\b/);
    expect(body).not.toContain("as unknown as");
    expect(body).not.toContain("as any");
    // A `!` would silence the nullability the SDK types are there to express.
    // A `!` would silence the nullability the SDK types exist to express.
    expect(body).not.toMatch(/[A-Za-z0-9_]!/);
    expect(body).not.toMatch(/[)]!/);
  });
});

/* -------------------------------------------------------------------------- */
/* Defect 2 — video: coordinator transport health, never identity            */
/* -------------------------------------------------------------------------- */

describe("#1829 isVideoClientLive reads coordinator health, not identity", () => {
  it("reports a healthy coordinator as live", () => {
    expect(isVideoClientLive(videoClient())).toBe(true);
  });

  it("does NOT mask a video-only outage as connected", () => {
    // THE regression. Identity is still fully populated — `connectedUser` is
    // only cleared by `disconnectUser` (`index.cjs.js:20051`), so a client whose
    // coordinator socket merely dropped looks completely identified. Pre-fix
    // this returned true and the provider adopted the dead client with
    // `videoConnected: true`.
    expect(isVideoClientLive(videoClient({ healthy: false }))).toBe(false);
  });

  it("still reports live when identity is ABSENT but the socket is up", () => {
    // The mirror image, and the reason identity was the wrong field in both
    // directions: a socket that is demonstrably up must not be reported dead
    // because some state field happens to be unset.
    expect(
      isVideoClientLive(videoClient({ healthy: true, identityPresent: false })),
    ).toBe(true);
  });

  it("treats a CONNECTING coordinator handshake as not live", () => {
    expect(
      isVideoClientLive(videoClient({ healthy: false, connecting: true })),
    ).toBe(false);
  });

  it("treats a missing coordinator connection as not live (fail closed)", () => {
    const fixture = videoClient();
    fixture.streamClient.wsConnection = null;
    expect(isVideoClientLive(fixture)).toBe(false);
  });

  it("refuses a healthy coordinator socket with no connectionID", () => {
    const fixture = videoClient();
    if (fixture.streamClient.wsConnection) {
      fixture.streamClient.wsConnection.connectionID = undefined;
    }
    expect(isVideoClientLive(fixture)).toBe(false);
  });

  it("reads no property the SDK does not declare", () => {
    const start = provider.indexOf("export function isVideoClientLive(");
    const body = provider.slice(start, provider.indexOf("\n}\n", start));
    // The identity read that made a dropped socket invisible.
    expect(body).not.toContain("connectedUser");
    // The video SDK vendors its own connection layer and that layer has NO
    // long-poll fallback (`dist/src/coordinator/connection/client.d.ts` declares
    // no `wsFallback`), so reading one here would be inventing a field.
    expect(body).not.toContain("wsFallback");
    expect(body).not.toContain("as unknown as");
    expect(body).not.toContain("as any");
    // A `!` would silence the nullability the SDK types exist to express.
    expect(body).not.toMatch(/[A-Za-z0-9_]!/);
    expect(body).not.toMatch(/[)]!/);
  });

  it("reads the coordinator on the client, not the app's chat singleton", () => {
    // Two StreamChat-shaped objects exist in this app and they are not the same
    // object: the provider's chat singleton, and the video SDK's own vendored
    // coordinator. The helper must read `client.streamClient`, because that is
    // the socket carrying the video session.
    const body = provider.slice(
      provider.indexOf("export function isVideoClientLive("),
      provider.indexOf(
        "\n}\n",
        provider.indexOf("export function isVideoClientLive("),
      ),
    );
    expect(body).toContain("client.streamClient");
  });
});

/* -------------------------------------------------------------------------- */
/* Defect 2 — the wiring: readiness must move, and must not overclaim        */
/* -------------------------------------------------------------------------- */

/**
 * Drops `//` comment lines. These branches are heavily commented and the prose
 * names the very identifiers the assertions below are about, so an assertion
 * over the raw text would be reading the comment rather than the code.
 * (`disconnectUser` also contains `connectUser` as a substring, which is the
 * same trap wearing a different hat.)
 */
const code = (source: string): string =>
  source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

describe("#1829 a video-only outage reaches the store and a retry", () => {
  /** The body of the video `connection.changed` effect, or null if it is gone. */
  const videoEffect = (): string => {
    const at = provider.indexOf('video.on("connection.changed"');
    if (at === -1) return "";
    const end = provider.indexOf("\n  }, [clients?.video", at);
    if (end === -1) return "";
    return provider.slice(at, end);
  };

  it("subscribes to the VIDEO client's own connection.changed", () => {
    // Without this the helper is right and nothing still calls it: a video-only
    // outage left `videoConnected: true` forever and triggered no recovery. The
    // event is part of the SDK's published union
    // (`dist/src/coordinator/connection/types.d.ts:66-69`, reached through
    // `AllClientEvents` at `:125` and `StreamVideoClient.on` at
    // `dist/src/StreamVideoClient.d.ts:90`), so this needs no cast and no
    // invented event name.
    expect(videoEffect()).not.toBe("");
  });

  it("publishes the outage and the recovery from that subscription", () => {
    const body = videoEffect();
    expect(body).toContain("setVideoConnected(false)");
    expect(body).toContain("setVideoConnected(true)");
    // Same grace window as chat, so the SDK's own reconnect still wins a lid-close.
    expect(body).toContain("RECONNECT_GRACE_MS");
    expect(body).toContain("connectServices()");
  });

  it("unsubscribes, so a replaced client cannot keep writing readiness", () => {
    expect(videoEffect()).toContain("unsubscribe()");
  });

  it("repairs a same-user client on the client it already has", () => {
    // Replacement was the only previous option, and it cost a whole new
    // StreamVideoClient per flap — including every `Call` in its state store.
    const repair = provider.indexOf("await coordinator.openConnection()");
    expect(repair).toBeGreaterThan(-1);
    // Same-user only: a client belonging to a different user is not ours to
    // repair, it has to be released and replaced.
    const branch = code(
      provider.slice(
        provider.lastIndexOf("if (sameUser && adoptable)", repair),
        repair,
      ),
    );
    expect(branch).toContain("sameUser && adoptable");
    // And never `connectUser` — re-awaiting the handshake is the short-circuit
    // path this branch is the counterpart of.
    expect(branch).not.toContain("connectUser");
  });

  it("does not claim readiness for an in-flight video handshake", () => {
    const inFlight = provider.indexOf("coordinator.wsConnection?.isConnecting");
    expect(inFlight).toBeGreaterThan(-1);
    const branch = provider.slice(
      inFlight,
      provider.indexOf("return adoptable;", inFlight),
    );
    // A mid-handshake socket may never finish connecting; the
    // `connection.changed` event is what earns the flag.
    expect(branch).not.toContain("setVideoConnected(true)");
    // And it must not open a second handshake behind one we do not own.
    expect(provider.slice(inFlight, inFlight + 400)).not.toContain(
      "openConnection()",
    );
  });

  it("leaves readiness FALSE when the reconnect is rejected", () => {
    // `openConnection` THROWS on a failed handshake. If the repair sat outside
    // the try, that rejection would skip the catch that clears readiness and
    // the store would keep claiming a live video client.
    const reopen = provider.indexOf("await coordinator.openConnection()");
    expect(reopen).toBeGreaterThan(-1);

    // The repair must be INSIDE the try whose catch owns the failure. Anchor on
    // the nearest preceding `try {` and assert it is still OPEN at the point the
    // repair lives: a `catch (error) {` in between would prove the repair is
    // outside it. The `> sectionStart` guard is what stops a repair hoisted out
    // of the try from quietly satisfying this by reaching back into
    // `connectChat`'s — `lastIndexOf` alone would do exactly that.
    const sectionStart = provider.indexOf("const connectVideo = useCallback(");
    const nearestTry = provider.lastIndexOf("try {", reopen);
    expect(nearestTry).toBeGreaterThan(sectionStart);
    expect(provider.slice(nearestTry, reopen)).not.toContain("catch (error) {");

    // Readiness is claimed only AFTER the await resolved, never before. The
    // outer catch is the one that owns the failure path — anchored on the log
    // line only it writes, not the first `catch` after the reopen.
    const outerCatch = provider.lastIndexOf(
      "catch (error) {",
      provider.indexOf('streamLogger.warn("Video connection failed"'),
    );
    expect(outerCatch).toBeGreaterThan(reopen);
    const between = provider.slice(reopen, outerCatch);
    expect(between.indexOf("setVideoConnected(true)")).toBeGreaterThan(
      between.lastIndexOf("await coordinator.openConnection()"),
    );
    expect(provider.slice(outerCatch, outerCatch + 400)).toContain(
      "setVideoConnected(false)",
    );
  });

  it("releases a client it is replacing without consulting liveness", () => {
    // Gating the teardown on `isVideoClientLive` would read "release it because
    // we are throwing it away" then "don't release it because it isn't live" —
    // leaking the one client still holding a socket's timers.
    const teardown = provider.indexOf(
      "await adoptable.disconnectUser().catch(() => undefined)",
    );
    expect(teardown).toBeGreaterThan(-1);
    const branch = provider.slice(
      provider.lastIndexOf("if (adoptable)", teardown),
      teardown,
    );
    expect(branch).not.toContain("isVideoClientLive");
    // And it must still precede the overwrite that orphans it.
    expect(teardown).toBeLessThan(
      provider.indexOf("setGlobalVideoClient(client)"),
    );
  });

  it("never turns a coordinator fact into a media fact", () => {
    // A recovered coordinator proves the app can reach the API again and nothing
    // more; SFU/media is a separate connection (video-js#2003). Nothing in the
    // provider may read or write call, track, SFU or participant state off this.
    const videoSection = provider.slice(
      provider.indexOf("const connectVideo = useCallback("),
      provider.indexOf(
        "// Stable connectServices",
        provider.indexOf("const connectVideo = useCallback("),
      ),
    );
    expect(videoSection).not.toMatch(
      /\b(call|sfu|track|participant|join|leave)\.(state|join|leave|get)\b/i,
    );
    expect(videoSection).not.toContain("mediaStream");
    // The only thing the coordinator fact is allowed to become.
    expect(videoSection).toContain("setVideoConnected");
    expect(videoSection).not.toContain("setMediaConnected");
  });

  it("says so in the source, so the next reader is not left to infer it", () => {
    expect(provider).toContain("COORDINATOR ONLY");
    expect(provider).toContain("video-js#2003");
  });
});
