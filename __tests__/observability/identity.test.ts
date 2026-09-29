/**
 * `lib/observability/identity` — the per-request identity stamp.
 *
 * The regression these pin down is the one that would have made this module
 * silently useless: `Sentry.setUser` REPLACES the whole user object rather
 * than merging, so a `setSentryOrgContext` that naively called it would drop
 * the `id` written moments earlier by `setSentryIdentity` and leave the event
 * unattributed — the exact failure the module exists to fix. `identity.ts`
 * therefore reads the current user off the isolation scope and merges.
 */

const setUser = jest.fn();
const setTag = jest.fn();
const getIsolationScope = jest.fn();

let currentUser: Record<string, unknown> | undefined;

jest.mock("@sentry/nextjs", () => ({
  setUser: (u: Record<string, unknown> | null) => {
    // Mirrors the SDK: assignment, not merge. The real isolation scope holds
    // exactly one user object, so replacing it drops everything not re-stated.
    currentUser = u ?? undefined;
    setUser(u);
  },
  setTag: (k: string, v: string) => setTag(k, v),
  getIsolationScope: () => getIsolationScope(),
}));

import {
  clearSentryIdentity,
  isSentryIdentityEnabled,
  ORG_ID_TAG,
  setSentryIdentity,
  setSentryIdentityFromSession,
  setSentryOrgContext,
} from "../../lib/observability/identity";

/**
 * The disclosure is DEFAULT OFF (see `isSentryIdentityEnabled`). These suites
 * exercise the ENABLED path — they are about what the module does when it
 * stamps — so they turn it on explicitly rather than relying on a default that
 * is deliberately the other way. The disabled path has its own tests below.
 */
beforeAll(() => {
  process.env.SENTRY_IDENTITY_ENABLED = "on";
});
afterAll(() => {
  delete process.env.SENTRY_IDENTITY_ENABLED;
});

beforeEach(() => {
  jest.clearAllMocks();
  currentUser = undefined;
  getIsolationScope.mockImplementation(() => ({ getUser: () => currentUser }));
  setUser.mockImplementation((u: Record<string, unknown> | null) => {
    currentUser = u ?? undefined;
  });
  setTag.mockImplementation(() => {});
});

describe("setSentryIdentity", () => {
  it("stamps the id and uses the role as the display label", () => {
    setSentryIdentity({ userId: "usr_123", role: "CONSULTANT" });
    expect(currentUser).toEqual({ id: "usr_123", username: "CONSULTANT" });
  });

  it("omits the label rather than sending an empty one when role is unknown", () => {
    setSentryIdentity({ userId: "usr_123" });
    expect(currentUser).toEqual({ id: "usr_123" });
  });

  it("does not send an email — that is the whole privacy posture", () => {
    setSentryIdentity({ userId: "usr_123", role: "CONSULTEE" });
    expect(currentUser).not.toHaveProperty("email");
  });
});

describe("setSentryIdentityFromSession", () => {
  it("reads id and role off a session", () => {
    setSentryIdentityFromSession({
      user: { id: "usr_9", role: "STAFF" },
    });
    expect(currentUser).toEqual({ id: "usr_9", username: "STAFF" });
  });

  it("no-ops for a missing session instead of stamping an empty user", () => {
    setSentryIdentityFromSession(null);
    setSentryIdentityFromSession(undefined);
    setSentryIdentityFromSession({ user: { id: "" } });
    expect(setUser).not.toHaveBeenCalled();
  });
});

describe("setSentryOrgContext", () => {
  it("keeps the user id that setSentryIdentity already wrote", () => {
    // The regression: a bare setUser here would wipe `id`.
    setSentryIdentity({ userId: "usr_123", role: "CONSULTEE" });
    setSentryOrgContext({ orgId: "org_abc", orgRole: "OWNER" });

    expect(currentUser).toEqual({
      id: "usr_123",
      username: "CONSULTEE",
      org_id: "org_abc",
      org_role: "OWNER",
    });
  });

  it("is also safe when the org is stamped first and the user second", () => {
    setSentryOrgContext({ orgId: "org_abc", orgRole: "OWNER" });
    setSentryIdentity({ userId: "usr_123" });

    expect(currentUser).toEqual({
      id: "usr_123",
      org_id: "org_abc",
      org_role: "OWNER",
    });
  });

  it("records the org as a searchable tag", () => {
    setSentryOrgContext({ orgId: "org_abc" });
    expect(setTag).toHaveBeenCalledWith(ORG_ID_TAG, "org_abc");
  });

  it("overwrites a previous org rather than accumulating a stale one", () => {
    setSentryOrgContext({ orgId: "org_one", orgRole: "LEARNER" });
    setSentryOrgContext({ orgId: "org_two", orgRole: "OWNER" });
    expect(currentUser).toEqual({ org_id: "org_two", org_role: "OWNER" });
  });

  // The merge is scoped to the keys this module owns, and every managed key the
  // caller did not supply is dropped first. A blind Object.assign keeps the
  // previous org's role here, and a support agent reading a money-path event
  // would be told the wrong person acted on it.
  it("drops the previous org's role and membership when the new context omits them", () => {
    setSentryIdentity({ userId: "usr_123" });
    setSentryOrgContext({
      orgId: "org_one",
      orgRole: "OWNER",
      membershipId: "mem_1",
    });
    setSentryOrgContext({ orgId: "org_two" });

    expect(currentUser).toEqual({ id: "usr_123", org_id: "org_two" });
  });

  it("drops the previous user's org when a different user signs in", () => {
    setSentryIdentity({ userId: "usr_a", role: "CONSULTEE" });
    setSentryOrgContext({ orgId: "org_one", orgRole: "OWNER" });
    setSentryIdentity({ userId: "usr_b", role: "STAFF" });

    expect(currentUser).toEqual({ id: "usr_b", username: "STAFF" });
  });

  // The two setters own disjoint key sets, because requireApiAuth stamps the
  // user and requireOrgAccess then stamps the org in the same request. A user
  // re-stamp (a second requireApiAuth in one request) must not wipe the org
  // that was already resolved.
  it("re-stamping the same user does not wipe an org already resolved", () => {
    setSentryIdentity({ userId: "usr_123", role: "CONSULTEE" });
    setSentryOrgContext({ orgId: "org_abc", orgRole: "OWNER" });
    setSentryIdentity({ userId: "usr_123", role: "CONSULTEE" });

    expect(currentUser).toEqual({
      id: "usr_123",
      username: "CONSULTEE",
      org_id: "org_abc",
      org_role: "OWNER",
    });
  });

  it("drops a stale role label when the new role is absent", () => {
    setSentryIdentity({ userId: "usr_123", role: "CONSULTANT" });
    setSentryIdentity({ userId: "usr_123" });
    expect(currentUser).toEqual({ id: "usr_123" });
  });

  // A deny list of managed keys can only be as complete as the set of fields
  // Sentry supports, and that set grows. An actor change therefore resets the
  // object outright, so nothing belonging to the previous actor survives — the
  // two fields that would actually hurt being `email` and `ip_address`.
  it("does not carry a previous actor's Sentry user fields across an actor change", () => {
    currentUser = {
      id: "usr_a",
      email: "a@example.test",
      ip_address: "203.0.113.9",
      segment: "beta",
    };
    setSentryIdentity({ userId: "usr_123", role: "STAFF" });

    expect(currentUser).toEqual({ id: "usr_123", username: "STAFF" });
  });

  it("still keeps non-identity fields when updating the same actor", () => {
    currentUser = { id: "usr_123", segment: "beta" };
    setSentryOrgContext({ orgId: "org_abc", orgRole: "OWNER" });
    expect(currentUser).toEqual({
      id: "usr_123",
      segment: "beta",
      org_id: "org_abc",
      org_role: "OWNER",
    });
  });

  it("leaves fields it does not own alone", () => {
    // A future integration may set its own user fields; this module must not
    // strip them just because it is rewriting the ones it owns.
    currentUser = { id: "usr_123", segment: "beta" };
    setSentryOrgContext({ orgId: "org_two" });
    expect(currentUser).toEqual({
      id: "usr_123",
      segment: "beta",
      org_id: "org_two",
    });
  });

  it("omits the membership id for an admin crossing a tenant boundary", () => {
    // requireOrgAccess passes no membershipId on the admin path, because the
    // `__admin_stub_…` value is not a real Membership.id and would be a
    // broken join key for whoever reads the user panel.
    setSentryOrgContext({ orgId: "org_abc", orgRole: "ADMIN" });
    expect(currentUser).not.toHaveProperty("membership_id");
  });
});

describe("clearSentryIdentity", () => {
  it("drops the identity so the next anonymous session is not misattributed", () => {
    setSentryIdentity({ userId: "usr_123", role: "CONSULTEE" });
    setSentryOrgContext({ orgId: "org_abc" });
    clearSentryIdentity();
    expect(currentUser).toBeUndefined();
  });
});

describe("degradation", () => {
  // These are not hypothetical. `requireApiAuth()` and `requireOrgAccess()`
  // are the auth chokepoint, so an observability helper that raised inside
  // them would convert a 500 into a different 500 on the one path that
  // decides whether the user gets an answer at all. Roughly 60 suites in this
  // repo mock `@sentry/nextjs` down to `captureException`, so a partially
  // available SDK is a real condition, not a corner case.

  afterEach(() => {
    getIsolationScope.mockRestore();
    setUser.mockImplementation((u: Record<string, unknown> | null) => {
      currentUser = u ?? undefined;
    });
  });

  it("still stamps the id when the isolation scope is unavailable", () => {
    getIsolationScope.mockImplementation(() => {
      throw new Error("older SDK");
    });
    setSentryIdentity({ userId: "usr_123", role: "CONSULTEE" });
    expect(setUser).toHaveBeenCalledWith({
      id: "usr_123",
      username: "CONSULTEE",
    });
  });

  it("does not throw when neither path is available", () => {
    getIsolationScope.mockImplementation(() => {
      throw new Error("older SDK");
    });
    setUser.mockImplementation(() => {
      throw new Error("Sentry disabled");
    });
    expect(() => setSentryIdentity({ userId: "usr_123" })).not.toThrow();
  });

  // With the scope unreadable, a remembered process-wide user would be
  // routinely a DIFFERENT request's user on a warm Lambda. Refusing to guess
  // is the only safe answer: an event attributed to nobody beats an event
  // attributed to the wrong person.
  it("stamps only the id when the scope cannot be read, and never a remembered user", () => {
    setSentryIdentity({ userId: "usr_123", role: "CONSULTEE" });
    getIsolationScope.mockImplementation(() => {
      throw new Error("older SDK");
    });
    setSentryIdentity({ userId: "usr_999", role: "STAFF" });

    expect(setUser).toHaveBeenLastCalledWith({
      id: "usr_999",
      username: "STAFF",
    });
  });

  // A tenant tag on an event with no user is a claim about nobody: the org it
  // names is not evidence of who the event belongs to.
  it("does not stamp an org, or its tag, that it cannot attribute to anyone", () => {
    getIsolationScope.mockImplementation(() => {
      throw new Error("older SDK");
    });
    setSentryOrgContext({ orgId: "org_abc", orgRole: "OWNER" });
    expect(setUser).not.toHaveBeenCalled();
    expect(setTag).not.toHaveBeenCalled();
  });

  it("does not throw when the org tag cannot be set", () => {
    setTag.mockImplementation(() => {
      throw new Error("Sentry disabled");
    });
    expect(() => setSentryOrgContext({ orgId: "org_abc" })).not.toThrow();
  });

  it("does not throw when clearing the identity fails", () => {
    setUser.mockImplementation(() => {
      throw new Error("Sentry disabled");
    });
    expect(() => clearSentryIdentity()).not.toThrow();
  });
});

describe("the org_id tag", () => {
  // The tag is set only by setSentryOrgContext, but the client isolation scope
  // outlives a session — so both "the actor changed" and "the actor went away"
  // have to retract it, or the next person's client events carry the previous
  // org.
  it("is set when an org is resolved", () => {
    setSentryOrgContext({ orgId: "org_abc" });
    expect(setTag).toHaveBeenCalledWith(ORG_ID_TAG, "org_abc");
  });

  it("is retracted when a different user signs in", () => {
    setSentryIdentity({ userId: "usr_a" });
    setSentryOrgContext({ orgId: "org_abc", orgRole: "OWNER" });
    setTag.mockClear();

    setSentryIdentity({ userId: "usr_b" });
    expect(setTag).toHaveBeenCalledWith(ORG_ID_TAG, "");
  });

  it("is retained when the same user is re-stamped in the same request", () => {
    setSentryIdentity({ userId: "usr_a", role: "CONSULTEE" });
    setSentryOrgContext({ orgId: "org_abc" });
    setTag.mockClear();

    setSentryIdentity({ userId: "usr_a", role: "CONSULTEE" });
    expect(setTag).not.toHaveBeenCalled();
  });

  it("is retracted on sign-out", () => {
    setSentryIdentity({ userId: "usr_a" });
    setSentryOrgContext({ orgId: "org_abc" });
    setTag.mockClear();

    clearSentryIdentity();
    expect(setTag).toHaveBeenCalledWith(ORG_ID_TAG, "");
  });
});

describe("the disclosure switch, which is DEFAULT OFF", () => {
  const original = process.env.SENTRY_IDENTITY_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.SENTRY_IDENTITY_ENABLED;
    else process.env.SENTRY_IDENTITY_ENABLED = original;
  });

  it("is off when the variable is unset — the state production ships in", () => {
    delete process.env.SENTRY_IDENTITY_ENABLED;
    expect(isSentryIdentityEnabled()).toBe(false);
  });

  it.each(["true", "1", "yes", "ON", "On", "enabled", ""])(
    "treats %p as OFF, so a typo cannot switch a disclosure on",
    (value) => {
      process.env.SENTRY_IDENTITY_ENABLED = value;
      expect(isSentryIdentityEnabled()).toBe(false);
    },
  );

  it("is on only for the exact value 'on'", () => {
    process.env.SENTRY_IDENTITY_ENABLED = "on";
    expect(isSentryIdentityEnabled()).toBe(true);
  });

  it("stamps nothing when off, and never reaches the SDK", () => {
    delete process.env.SENTRY_IDENTITY_ENABLED;
    setSentryIdentity({ userId: "usr_gate", role: "STAFF" });
    setSentryOrgContext({ orgId: "org_gate", orgRole: "OWNER" });
    expect(setUser).not.toHaveBeenCalled();
    expect(setTag).not.toHaveBeenCalled();
  });

  it("leaves the org off too — not just the user", () => {
    // The tenant is the more sensitive half: it names a company and a role.
    // Gating only the user stamp would leave a named org on an anonymous event.
    delete process.env.SENTRY_IDENTITY_ENABLED;
    setSentryOrgContext({ orgId: "org_gate2", orgRole: "ADMIN" });
    expect(setUser).not.toHaveBeenCalled();
    expect(setTag).not.toHaveBeenCalled();
  });

  it("still CLEARS when off, so a previous user cannot survive on the client scope", () => {
    // The one asymmetry, and it is deliberate: clearing is always safe, and on
    // the client the isolation scope outlives a sign-out. An unset switch must
    // never be why a stale identity persists.
    delete process.env.SENTRY_IDENTITY_ENABLED;
    clearSentryIdentity();
    expect(setUser).toHaveBeenCalledWith(null);
  });

  it("reads the switch per call, not at module load", () => {
    // A module-level read would freeze the decision at import time, which would
    // make it untestable and unchangeable without a rebuild.
    delete process.env.SENTRY_IDENTITY_ENABLED;
    expect(isSentryIdentityEnabled()).toBe(false);
    process.env.SENTRY_IDENTITY_ENABLED = "on";
    expect(isSentryIdentityEnabled()).toBe(true);
  });
});
