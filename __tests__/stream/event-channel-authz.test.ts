import { WEBINAR_PREFIX } from "../../lib/stream-channel-ids";

/**
 * Authorization teeth for the two membership mutations in
 * `actions/stream/chat/event-channel.action.ts`.
 *
 * That module is `"use server"`, so BOTH exports are remotely invocable RPC
 * endpoints, and both used to take the TARGET user from the caller with no
 * session at all — which let any authenticated browser add an arbitrary user
 * (including one from an unrelated organisation) to any `webinar-*`/`class-*`
 * channel, mint that channel with its full roster, or evict a real participant
 * from a paid event. `removeUserFromEventChannel` is the worse half: a removal
 * is access revocation.
 *
 * These tests pin the gate that closed it — `requireEventChannelActor`, which
 * mirrors `assertCanMintToken` (stream.action.ts):
 *
 *     MAY_ACT(target) :=
 *          session exists, read with the cookie cache DISABLED
 *       && !session.user.banned
 *       && ( session.user.id === target       — self-service
 *         || isPrivileged(session.user.role)  — platform operator
 *         || isEventChannelHost(...)          — the event's own consultant,
 *                                                REMOVALS only )
 *
 * Every refusal case below asserts the Stream provider was never reached:
 * `addMembers`, `removeMembers` and `create` must all be untouched, because
 * Stream's server API performs no permission check of its own — the session
 * bind is the entire boundary. Revert the gate and this file fails.
 */

// Self-contained on purpose: the shared `./__mocks__/stream-mocks` factories
// trip `jest/no-mocks-import` (the sibling suite already carries that error),
// and the revocation half of this surface needs a `removeMembers` the shared
// channel factory does not have. Only the delegates these paths actually reach
// are modelled.
const mockPrisma = {
  user: { findUnique: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
  webinar: { findUnique: jest.fn(), findMany: jest.fn() },
  class: { findUnique: jest.fn(), findMany: jest.fn() },
  consultation: { findUnique: jest.fn(), findMany: jest.fn() },
  subscription: { findUnique: jest.fn(), findMany: jest.fn() },
  appointmentOccurrence: { findFirst: jest.fn(), findMany: jest.fn() },
};
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
const mockCache = {
  markChannelExists: jest.fn(),
  isChannelCached: jest.fn(),
  getMembershipCached: jest.fn(),
  markMembership: jest.fn(),
  initialSyncCompletedUsers: new Set<string>(),
};

// The shared channel factory has no `removeMembers`, and the revocation path is
// half of what is under test — so the channel is built here.
const mockChannel = {
  create: jest.fn().mockResolvedValue({}),
  query: jest.fn().mockResolvedValue({ members: {} }),
  addMembers: jest.fn().mockResolvedValue({}),
  removeMembers: jest.fn().mockResolvedValue({}),
  assignRoles: jest.fn().mockResolvedValue({}),
  id: "test-channel",
  type: "team",
  data: { name: "Test Channel" },
  state: { members: {} },
};
const mockStreamClient = {
  channel: jest.fn(() => mockChannel),
  queryChannels: jest.fn().mockResolvedValue([]),
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: mockPrisma,
}));

jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: jest.fn(() => mockStreamClient),
  // #473 — pass-through breaker (closed-state behaviour): run the operation
  // directly so assertions on the Stream calls themselves hold.
  withStreamCircuitBreaker: jest.fn((op: () => unknown) => op()),
  StreamUnavailableError: class StreamUnavailableError extends Error {},
  isExpectedStreamError: jest.fn(() => false),
}));

jest.mock("../../lib/stream-logger", () => ({ streamLogger: mockLogger }));

jest.mock("../../lib/stream-cache", () => mockCache);

jest.mock("../../actions/stream/chat/user.action", () => ({
  upsertUserToStream: jest.fn().mockResolvedValue({}),
  upsertUsersToStream: jest.fn().mockResolvedValue({ users: {} }),
}));

// Mocking auth-server also keeps jest away from lib/auth's better-auth ESM
// imports, the same reason the sibling suite does.
const mockGetSession = jest.fn();
jest.mock("../../lib/auth-server", () => ({
  getSession: (disableCookieCache?: boolean) =>
    mockGetSession(disableCookieCache),
}));

// auth-helpers imports next/server (NextResponse), which needs fetch globals
// jest's node env lacks — mirror the real one-liner instead.
jest.mock("../../lib/auth-helpers", () => ({
  isPrivileged: (role?: string | null) => role === "ADMIN" || role === "STAFF",
}));

// A real import, used below: it also makes this file a MODULE rather than a
// script. Without one, tsc puts every top-level `mock*` const into the global
// scope, where it collides with any other script-mode suite in
// `__tests__/stream/` ("Cannot redeclare block-scoped variable").

/**
 * Loaded lazily, per test: a static import hoists the module above the `mock*`
 * consts the factories above close over. The sibling suite does the same.
 */
function loadActions() {
  return import("../../actions/stream/chat/event-channel.action");
}

/** A webinar whose plan is hosted by `hostUserId`. */
function webinarHostedBy(hostUserId: string) {
  return {
    id: "web-1",
    webinarPlan: {
      consultantProfile: { user: { id: hostUserId } },
      collaborators: [],
    },
    appointment: { participants: [{ userId: "attendee-1" }] },
  };
}

/**
 * The gate must actually have run — an allow-path assertion, so the positive
 * capability tests cannot pass on un-gated code either (pre-fix the action
 * never read a session at all).
 */
function expectGateConsultedSession() {
  expect(mockGetSession).toHaveBeenCalledWith(true);
}

/** The provider must be untouched in a refusal — that IS the vulnerability. */
function expectNoProviderCall() {
  expect(mockChannel.addMembers).not.toHaveBeenCalled();
  expect(mockChannel.removeMembers).not.toHaveBeenCalled();
  expect(mockChannel.create).not.toHaveBeenCalled();
}

describe("event-channel membership actions — authorization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStreamClient.channel.mockReturnValue(mockChannel);
    mockCache.getMembershipCached.mockReturnValue(undefined);
    mockCache.isChannelCached.mockReturnValue(undefined);
    // Default: an ordinary signed-in member. Cross-user cases set their own.
    mockGetSession.mockResolvedValue({ user: { id: "user-a", role: "USER" } });
    mockPrisma.webinar.findUnique.mockResolvedValue(
      webinarHostedBy("user-host"),
    );
  });

  describe("unauthenticated callers", () => {
    it("refuses to add a third party and never reaches the provider", async () => {
      const { addUserToEventChannel } = await loadActions();
      mockGetSession.mockResolvedValue(null);

      const result = await addUserToEventChannel(
        "webinar",
        "web-1",
        "victim-from-another-org",
      );

      expect(result.success).toBe(false);
      expect(result.refusal?.code).toBe("UNAUTHENTICATED");
      // A refusal must cost no metered write AND must not mint the channel
      // with its full roster.
      expectNoProviderCall();
      // Not even a database read: the gate runs before anything else.
      expect(mockPrisma.webinar.findUnique).not.toHaveBeenCalled();
    });

    it("refuses to evict a participant and never reaches the provider", async () => {
      const { removeUserFromEventChannel } = await loadActions();
      mockGetSession.mockResolvedValue(null);

      const result = await removeUserFromEventChannel(
        "webinar",
        "web-1",
        "paying-attendee",
      );

      expect(result).toEqual({ success: false });
      expectNoProviderCall();
      expect(mockPrisma.webinar.findUnique).not.toHaveBeenCalled();
      // Nor may a refused removal poison the membership cache of someone who
      // is still a member — `markMembership(..., false)` is the failure path's.
      expect(mockCache.markMembership).not.toHaveBeenCalled();
    });

    it("reads the session with the cookie cache DISABLED", async () => {
      const { addUserToEventChannel, removeUserFromEventChannel } =
        await loadActions();
      mockGetSession.mockResolvedValue(null);

      await addUserToEventChannel("webinar", "web-1", "user-a");
      expect(mockGetSession).toHaveBeenCalledWith(true);

      mockGetSession.mockClear();
      await removeUserFromEventChannel("webinar", "web-1", "user-a");
      expect(mockGetSession).toHaveBeenCalledWith(true);
    });
  });

  describe("a non-privileged member", () => {
    it("may add ITSELF", async () => {
      const { addUserToEventChannel } = await loadActions();

      const result = await addUserToEventChannel("webinar", "web-1", "user-a");

      expect(result).toMatchObject({
        success: true,
        channelId: `${WEBINAR_PREFIX}web-1`,
      });
      expect(mockChannel.addMembers).toHaveBeenCalledWith(["user-a"]);
      expectGateConsultedSession();
    });

    it("may remove ITSELF", async () => {
      const { removeUserFromEventChannel } = await loadActions();

      const result = await removeUserFromEventChannel(
        "webinar",
        "web-1",
        "user-a",
      );

      expect(result).toEqual({ success: true });
      expect(mockChannel.removeMembers).toHaveBeenCalledWith(["user-a"]);
      expectGateConsultedSession();
    });

    it("may NOT add another userId — the cross-organisation escalation", async () => {
      const { addUserToEventChannel } = await loadActions();

      await expect(
        addUserToEventChannel("webinar", "web-1", "user-from-another-org"),
      ).rejects.toThrow(/Forbidden/);

      expectNoProviderCall();
      // The host grant is removals-only, so ADD must not even consult the
      // event's owner to justify itself.
      expect(mockPrisma.webinar.findUnique).not.toHaveBeenCalled();
    });

    it("may NOT evict another userId", async () => {
      const { removeUserFromEventChannel } = await loadActions();

      await expect(
        removeUserFromEventChannel("webinar", "web-1", "paying-attendee"),
      ).rejects.toThrow(/Forbidden/);

      expectNoProviderCall();
      expect(mockCache.markMembership).not.toHaveBeenCalled();
    });

    it("is refused for every unprivileged role spelling, not just USER", async () => {
      const { removeUserFromEventChannel } = await loadActions();

      for (const role of ["CONSULTANT", "CONSULTEE", "USER", undefined]) {
        mockGetSession.mockResolvedValue({ user: { id: "user-a", role } });
        await expect(
          removeUserFromEventChannel("webinar", "web-1", "someone-else"),
        ).rejects.toThrow(/Forbidden/);
      }
      expectNoProviderCall();
    });
  });

  describe("a privileged operator", () => {
    it("may add another user — and the privilege is what allows it", async () => {
      const { addUserToEventChannel } = await loadActions();
      mockGetSession.mockResolvedValue({
        user: { id: "admin-1", role: "ADMIN" },
      });

      const result = await addUserToEventChannel(
        "webinar",
        "web-1",
        "user-from-another-org",
      );

      expect(result.success).toBe(true);
      expect(mockChannel.addMembers).toHaveBeenCalledWith([
        "user-from-another-org",
      ]);
      expectGateConsultedSession();
      // A platform operator needs no ownership proof, so the event owner is
      // never resolved for them.
      expect(mockPrisma.webinar.findUnique).not.toHaveBeenCalled();
    });

    it("may remove another user", async () => {
      const { removeUserFromEventChannel } = await loadActions();
      mockGetSession.mockResolvedValue({
        user: { id: "staff-1", role: "STAFF" },
      });

      const result = await removeUserFromEventChannel(
        "webinar",
        "web-1",
        "paying-attendee",
      );

      expect(result).toEqual({ success: true });
      expect(mockChannel.removeMembers).toHaveBeenCalledWith([
        "paying-attendee",
      ]);
      expectGateConsultedSession();
    });
  });

  describe("the event's own consultant (removals only)", () => {
    // The capability the participant routes already rely on before they call
    // the removal (`isSelfLeave || isOrganiser`). It is scoped to one event and
    // must be, or a consultant could moderate somebody else's roster.
    it("may evict a member of their own event", async () => {
      const { removeUserFromEventChannel } = await loadActions();
      mockGetSession.mockResolvedValue({
        user: { id: "user-host", role: "USER" },
      });
      mockPrisma.webinar.findUnique.mockResolvedValue(
        webinarHostedBy("user-host"),
      );

      const result = await removeUserFromEventChannel(
        "webinar",
        "web-1",
        "paying-attendee",
      );

      expect(result).toEqual({ success: true });
      expect(mockChannel.removeMembers).toHaveBeenCalledWith([
        "paying-attendee",
      ]);
      expectGateConsultedSession();
    });

    it("may NOT do the same for an event they do not host", async () => {
      const { removeUserFromEventChannel } = await loadActions();
      mockGetSession.mockResolvedValue({
        user: { id: "user-host", role: "USER" },
      });
      mockPrisma.webinar.findUnique.mockResolvedValue(
        webinarHostedBy("somebody-else"),
      );

      await expect(
        removeUserFromEventChannel("webinar", "web-1", "paying-attendee"),
      ).rejects.toThrow(/Forbidden/);

      expectNoProviderCall();
    });

    it("does NOT get the grant on the ADD path", async () => {
      const { addUserToEventChannel } = await loadActions();
      mockGetSession.mockResolvedValue({
        user: { id: "user-host", role: "USER" },
      });
      mockPrisma.webinar.findUnique.mockResolvedValue(
        webinarHostedBy("user-host"),
      );

      await expect(
        addUserToEventChannel("webinar", "web-1", "user-from-another-org"),
      ).rejects.toThrow(/Forbidden/);

      expectNoProviderCall();
    });

    it("denies rather than widens when the event owner cannot be resolved", async () => {
      const { removeUserFromEventChannel } = await loadActions();
      mockGetSession.mockResolvedValue({
        user: { id: "user-host", role: "USER" },
      });
      mockPrisma.webinar.findUnique.mockRejectedValue(new Error("db down"));

      await expect(
        removeUserFromEventChannel("webinar", "web-1", "paying-attendee"),
      ).rejects.toThrow(/Forbidden/);

      expectNoProviderCall();
    });
  });

  describe("a banned account", () => {
    // Even with a session that looks entirely plausible — right id, right role
    // — a banned user gets no write. This is the case the disabled cookie cache
    // exists for: without `getSession(true)` a ban that lands mid-session is
    // invisible until the cache lapses.
    it("is refused an add, even for itself", async () => {
      const { addUserToEventChannel } = await loadActions();
      mockGetSession.mockResolvedValue({
        user: { id: "user-a", role: "USER", banned: true },
      });

      await expect(
        addUserToEventChannel("webinar", "web-1", "user-a"),
      ).rejects.toThrow(/suspended/);

      expectNoProviderCall();
    });

    it("is refused a removal, even for itself", async () => {
      const { removeUserFromEventChannel } = await loadActions();
      mockGetSession.mockResolvedValue({
        user: { id: "user-a", role: "USER", banned: true },
      });

      await expect(
        removeUserFromEventChannel("webinar", "web-1", "user-a"),
      ).rejects.toThrow(/suspended/);

      expectNoProviderCall();
    });

    it("is refused even when it claims ADMIN", async () => {
      const { removeUserFromEventChannel } = await loadActions();
      mockGetSession.mockResolvedValue({
        user: { id: "admin-1", role: "ADMIN", banned: true },
      });

      await expect(
        removeUserFromEventChannel("webinar", "web-1", "someone-else"),
      ).rejects.toThrow(/suspended/);

      expectNoProviderCall();
    });
  });
});
