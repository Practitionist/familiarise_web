/**
 * Acting-identity stamping for Sentry.
 *
 * The problem this solves: across 90 days of production the project captured
 * exactly one `Sentry.setUser()` call, client-side, on the email/password
 * sign-in path only. Every server-side event arrived with no user at all, so
 * the "Users affected" count was 0 on 38 of 40 open issues and the two that
 * did carry a "user" carried an IP-derived placeholder. A support agent
 * reading "the payment page 500s" had no way to find which of their users hit
 * it. See docs/observability/sentry/05-identity-and-triage.md.
 *
 * ## Why this is safe to call from a request handler
 *
 * Sentry forks the isolation scope around every server request boundary
 * automatically, and `Sentry.setUser`/`setTag` write to the *isolation*
 * scope, not the process scope. Calling these inside a route handler is
 * therefore per-request by construction: no AsyncLocalStorage plumbing, and
 * no possibility of one request's identity bleeding into a concurrent
 * request on a warm instance. This is the property that makes the whole
 * approach a few lines rather than a middleware framework.
 *
 * ## Why identity is set in three separate places
 *
 * There are three independent entry points into a request, and each owns a
 * different amount of context:
 *
 *   - `requireApiAuth()` (API routes) — knows the user, never the org.
 *   - `requireOrgAccess()` (org routes) — additionally knows the org and the
 *     caller's membership role, which the user-scoped entry point cannot see.
 *   - `resolveGuardSession()` (server components/pages) — knows the user.
 *
 * The org is deliberately NOT guessed from the membership list. A user can be
 * an active member of several orgs, and picking the "first" one would put a
 * confidently wrong tenant on money and booking events — worse than no tenant
 * at all, because it reads as authoritative. Org context is stamped only
 * where a route has actually resolved one.
 *
 * ## What is deliberately not sent
 *
 * No email. `User.id` is a cuid — an opaque random identifier with no personal
 * data encoded — and it is the join key support already holds, so an agent can
 * resolve a Sentry event to a person in-app without the address ever leaving
 * the system. Sending the email would buy nothing operationally and would add a
 * direct PII transfer to the processor.
 *
 * This is a pseudonym rather than an anonymous value, so it is personal data
 * under GDPR and DPDP, and the disclosure is a REAL INCREASE rather than a
 * negligible one. A cuid is not equivalent to the requester IP the SDK already
 * collects: an IP names a network location, is often shared, and changes with
 * the connection, whereas a cuid names exactly one account, never changes, and
 * links every error that person has ever had straight to them through our own
 * database. See docs/observability/sentry/05-identity-and-triage.md for the
 * side-by-side.
 *
 * What makes it defensible rather than merely arguable is narrower than "we
 * already collect an IP": it is a pseudonym and not an identity, the mapping
 * stays in our database, no email/name/phone/address is sent by this module,
 * and it is an explicit documented label rather than a field the SDK inferred,
 * which is what makes the disclosure reviewable at all.
 *
 * Revocability is PARTIAL and should not be overstated. `clearSentryIdentity`
 * removes the id from the live scope, so no subsequent event carries it. It
 * does not un-send anything already delivered: Sentry retains events for its
 * retention window, so a cuid in a historical event stays a usable link until
 * that event ages out or is deleted. Account erasure therefore does not
 * retroactively anonymise the processor's copy.
 *
 * Any change here should go through the DPA, data-inventory and privacy-notice
 * review recorded in that doc, not just a code review.
 */

import * as Sentry from "@sentry/nextjs";

/**
 * `org_id` as a searchable tag, because Sentry has no first-class tenant field
 * and this is the only way `org_id:<cuid>` works in the issue search box.
 *
 * Cardinality caveat: one value per tenant is high-cardinality by
 * construction, and Sentry's tag-distribution UI degrades on such keys
 * (getsentry/sentry#94727). Acceptable while the org count is in the tens or
 * low hundreds, which is the current shape.
 */
export const ORG_ID_TAG = "org_id";

/**
 * Value written to {@link ORG_ID_TAG} when there is no tenant for the event.
 *
 * There is no unset API — `Scope.setTags` spreads, so assigning `undefined`
 * would leave the key present with an `undefined` value rather than removing
 * it, and an empty string is a valid, filterable string. One extra distinct tag
 * value is a fair price for a tag that cannot claim a tenant it does not have.
 */
const ORG_ID_TAG_NONE = "";

/**
 * Clear the tenant tag. Called whenever the actor changes or goes away, so a
 * client-side scope (which outlives a sign-out) cannot keep filing events
 * against the org of whoever was signed in last.
 */
function clearOrgTag(): void {
  try {
    Sentry.setTag(ORG_ID_TAG, ORG_ID_TAG_NONE);
  } catch {
    // Best-effort; the user fields below carry the same information.
  }
}

/** The subset of the Better Auth session this module needs. */
export interface SentrySessionIdentity {
  user: {
    id: string;
    sentryUserId?: string | null;
    role?: string | null;
  };
}

export interface SentryIdentity {
  userId: string;
  /** Platform role (`CONSULTEE`, `CONSULTANT`, `STAFF`, `ADMIN`, …). */
  role?: string | null;
}

export interface SentryOrgContext {
  orgId: string;
  /** The caller's role *in this org* — distinct from the platform role. */
  orgRole?: string | null;
  /** The `Membership.id`, for org-scoped audit joins. */
  membershipId?: string | null;
}

const VIRTUAL_TOKEN_PREFIX = "ust_";

// Compact RFC 6234 SHA-256 + RFC 2104 HMAC-SHA256 with zero Node built-ins so
// `identity.ts` stays importable in both server routes and `"use client"`
// bundles without bundler polyfills.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Bytes(input: Uint8Array): Uint8Array {
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const bitLen = input.length * 8;
  const padLen = (((input.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(padLen);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padLen - 4, bitLen >>> 0, false);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const v0 = w[i - 15]!;
      const s0 =
        ((v0 >>> 7) | (v0 << 25)) ^ ((v0 >>> 18) | (v0 << 14)) ^ (v0 >>> 3);
      const v1 = w[i - 2]!;
      const s1 =
        ((v1 >>> 17) | (v1 << 15)) ^ ((v1 >>> 19) | (v1 << 13)) ^ (v1 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const s1 =
        ((e >>> 6) | (e << 26)) ^
        ((e >>> 11) | (e << 21)) ^
        ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const s0 =
        ((a >>> 2) | (a << 30)) ^
        ((a >>> 13) | (a << 19)) ^
        ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return out;
}

function utf8ToBytes(str: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
      const next = str.charCodeAt(++i);
      c = 0x10000 + (((c & 0x3ff) << 10) | (next & 0x3ff));
      bytes.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

function hmacSha256Hex(keyStr: string, messageStr: string): string {
  let keyBytes = utf8ToBytes(keyStr);
  if (keyBytes.length > 64) {
    keyBytes = sha256Bytes(keyBytes);
  }
  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    const b = keyBytes[i] ?? 0;
    ipad[i] = b ^ 0x36;
    opad[i] = b ^ 0x5c;
  }
  const msgBytes = utf8ToBytes(messageStr);
  const innerInput = new Uint8Array(64 + msgBytes.length);
  innerInput.set(ipad, 0);
  innerInput.set(msgBytes, 64);
  const innerHash = sha256Bytes(innerInput);

  const outerInput = new Uint8Array(64 + 32);
  outerInput.set(opad, 0);
  outerInput.set(innerHash, 64);
  const digest = sha256Bytes(outerInput);

  let hex = "";
  for (let i = 0; i < digest.length; i++) {
    hex += digest[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Resolve the `user.id` sent to Sentry and queried by `sentry-issues.ts`.
 *
 * When `SENTRY_IDENTITY_SALT` is set on the server, returns a deterministic
 * HMAC-SHA256 virtual token (`ust_<32-hex>`) so raw database CUIDs never leave
 * the system while back-office lookups (`findUserIssues`) and client sessions
 * (`customSession.user.sentryUserId`) join on the exact same token.
 * Idempotent on already-hashed `ust_` tokens.
 */
export function resolveSentryUserId(userId: string): string {
  if (!userId || userId.startsWith(VIRTUAL_TOKEN_PREFIX)) return userId;
  const salt = process.env.SENTRY_IDENTITY_SALT?.trim();
  if (!salt) return userId;
  return `${VIRTUAL_TOKEN_PREFIX}${hmacSha256Hex(salt, userId).slice(0, 32)}`;
}

const USER_SCOPE_ATTRIBUTES = ["user.id", "user.role"] as const;
const ORG_SCOPE_ATTRIBUTES = [
  "org.id",
  "org.role",
  "org.membership_id",
] as const;

function setScopeAttributes(attrs: Record<string, string>): void {
  try {
    if (typeof Sentry.setAttributes === "function") {
      Sentry.setAttributes(attrs);
    }
  } catch {
    // Best-effort; partially mocked SDKs in tests omit setAttributes.
  }
}

function removeScopeAttributes(keys: readonly string[]): void {
  try {
    const scope = Sentry.getIsolationScope() as unknown as {
      removeAttribute?: (key: string) => void;
    };
    if (typeof scope?.removeAttribute === "function") {
      for (const key of keys) {
        scope.removeAttribute(key);
      }
    }
  } catch {
    // Best-effort.
  }
}

/**
 * The user-object keys this module owns. Everything else on the object belongs
 * to whoever set it and is left alone.
 *
 * The two setters own DISJOINT subsets, which is why the ownership is passed
 * in rather than baked in. `requireApiAuth()` stamps the user and
 * `requireOrgAccess()` then stamps the org, in that order, in the same request
 * — so an org stamp must not clear the id, and a user stamp must not clear the
 * org it is not setting.
 */
const IDENTITY_KEYS = ["id", "username"] as const;
const ORG_KEYS = ["org_id", "org_role", "membership_id"] as const;

/**
 * Sentry's own user fields, cleared when the actor changes. This module never
 * writes `email` or `ip_address`, but another integration or a future version
 * of this one might, and a fresh actor inheriting the previous actor's address
 * would be a privacy failure that looks like correct code.
 */
const ACTOR_IDENTITY_KEYS = [...IDENTITY_KEYS, "email", "ip_address"] as const;

/**
 * `Sentry.setUser` REPLACES the whole user object rather than merging, so a
 * second call that only meant to add the org would silently drop the user id
 * and leave the event unattributed — the exact failure this module exists to
 * fix.
 *
 * The merge is scoped to `owned` rather than a blind `Object.assign`: every
 * owned key the caller did NOT supply is removed first, so a label cannot
 * outlive the fact that made it true. A blind merge has three ways to be
 * wrong, all of them real here: switching orgs keeps the previous org's role,
 * signing in as a different user keeps the previous user's org, and a
 * downgraded role keeps the old label because the new one happened to be
 * absent rather than empty.
 *
 * Every call in this module is best-effort and must not throw. The call sites
 * are `requireApiAuth()`, `requireOrgAccess()` and the page guards: an
 * observability helper that raised inside the auth chokepoint would convert a
 * 500 into a different 500, and would do so on the one path that decides
 * whether the user gets an answer at all. A partially-available SDK (an older
 * version without `getIsolationScope`, a tree-shaken build, a test double)
 * degrades to "no identity", which is the pre-existing behaviour, not to a new
 * failure.
 */
function mergeUser(
  fields: Record<string, unknown>,
  owned: readonly string[],
  opts: { reset?: boolean } = {},
): boolean {
  let current: Record<string, unknown> | undefined;
  try {
    current = Sentry.getIsolationScope().getUser() as
      Record<string, unknown> | undefined;
  } catch {
    // The scope cannot be read, so nothing on it can be trusted as belonging to
    // THIS request. Remembering the last user seen process-wide and merging
    // that would be actively harmful: a warm Lambda serves requests
    // concurrently, so the remembered user is routinely a DIFFERENT person's,
    // and an event attributed to the wrong actor is a worse outcome than an
    // event attributed to nobody — it is the exact harm the isolation scope
    // exists to prevent, reintroduced through the back door.
    //
    // So the fallback is request-scoped: stamp only what this request itself
    // proved, which is the user id, and nothing else.
    if (!("id" in fields)) return false;
    current = undefined;
  }
  // `reset` drops everything on the scope rather than carrying it forward. A
  // deny list can only be as complete as the set of fields Sentry supports,
  // and that set grows; a full reset does not care. It is used exactly when the
  // actor changes, so a previous actor's fields cannot survive the switch.
  const base = opts.reset ? {} : (current ?? {});
  const next: Record<string, unknown> = { ...base };
  for (const key of owned) {
    if (!(key in fields)) delete next[key];
  }
  Object.assign(next, fields);
  try {
    Sentry.setUser(next);
    return true;
  } catch (err) {
    console.warn(
      "[sentry-identity] could not stamp user:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * Master switch for the acting-identity disclosure. **DEFAULT OFF.**
 *
 * Why a switch at all, and why off: attaching a stable pseudonymous user id to
 * every error event is a real increase in personal data processed by a third
 * party, and the data principal here is in India while Sentry's region is not —
 * so every event is a transfer out of India, which DPDP §16 governs
 * separately from the consent that would justify the processing. Consent and
 * transfer are different gates, and only one of them is ours to set. See
 * docs/compliance/09-dpdp-and-privacy.md and the preconditions in
 * docs/observability/sentry/05-identity-and-triage.md.
 *
 * Consequence of off: the back to `Users: 0` on most issues, which is the
 * state this module was written to fix. That is the deliberate trade — an
 * unattributable error is an operational cost, a disclosed pseudonym is a legal
 * one, and only the second is irreversible.
 *
 * Fail-closed on purpose: the check is an exact `=== "on"`, so unset, `true`,
 * `1`, `yes` and a typo are all OFF. A privacy gate that a misspelling can
 * switch on is not a gate.
 *
 * The intended end state is per-user consent on top of this — but consumer
 * consent does not exist yet (`docs/compliance/08` Gap #1, Phase 3), so there is
 * nothing to check per user. This flag is the coarse switch that has to exist
 * first; it is not the finished answer and should not be read as one.
 *
 * Read per call, not at module load, so a test can toggle it and so a runtime
 * env change takes effect without a rebuild. Checks both
 * `SENTRY_IDENTITY_ENABLED` (server) and `NEXT_PUBLIC_SENTRY_IDENTITY_ENABLED`
 * (browser bundle, where Next.js only inlines `NEXT_PUBLIC_*` variables).
 */
export function isSentryIdentityEnabled(): boolean {
  if (process.env.SENTRY_IDENTITY_ENABLED !== undefined) {
    return process.env.SENTRY_IDENTITY_ENABLED === "on";
  }
  return process.env.NEXT_PUBLIC_SENTRY_IDENTITY_ENABLED === "on";
}

/**
 * Stamp the acting user onto the current isolation scope.
 *
 * Idempotent and cheap: it only touches the isolation scope, issues no I/O,
 * and is safe to call from any code path that already holds a session.
 */
export function setSentryIdentity(identity: SentryIdentity): void {
  if (!isSentryIdentityEnabled()) return;
  const resolvedUserId = resolveSentryUserId(identity.userId);
  const fields: Record<string, unknown> = {
    id: resolvedUserId,
    // `username` is the human-facing label Sentry shows next to the id; the
    // role is the most useful thing to see at a glance while triaging and
    // carries no PII. Left unset (rather than null) so Sentry falls back to
    // the id rather than rendering an empty label.
    ...(identity.role ? { username: identity.role } : {}),
  };
  // A DIFFERENT actor invalidates any tenant carried over from a previous
  // session, so the org keys are cleared with the identity. Re-stamping the
  // same user (a second `requireApiAuth` in one request) must not, or it would
  // wipe an org that `requireOrgAccess` had already resolved.
  let owned: readonly string[] = IDENTITY_KEYS;
  let actorChanged = false;
  try {
    const current = Sentry.getIsolationScope().getUser() as
      { id?: unknown } | undefined;
    if (current?.id !== undefined && current.id !== resolvedUserId) {
      owned = ACTOR_IDENTITY_KEYS;
      actorChanged = true;
    }
  } catch {
    // Cannot read the scope; the conservative choice is to treat it as a
    // possible actor change, so the previous actor's fields go rather than
    // staying.
    owned = ACTOR_IDENTITY_KEYS;
    actorChanged = true;
  }
  mergeUser(fields, owned, { reset: actorChanged });
  if (actorChanged) {
    clearOrgTag();
    removeScopeAttributes(ORG_SCOPE_ATTRIBUTES);
  }
  if (!identity.role) {
    removeScopeAttributes(["user.role"]);
  }
  setScopeAttributes({
    "user.id": resolvedUserId,
    ...(identity.role ? { "user.role": identity.role } : {}),
  });
}

/** Stamp the acting user from a resolved session. */
export function setSentryIdentityFromSession(
  session: SentrySessionIdentity | null | undefined,
): void {
  const rawId = session?.user?.sentryUserId || session?.user?.id;
  if (!rawId) return;
  setSentryIdentity({ userId: rawId, role: session?.user?.role });
}

/**
 * Stamp the resolved tenant. Call this only from a code path that has
 * actually resolved the org for the request — never infer it from a
 * membership list, which is ambiguous for multi-tenant users.
 */
export function setSentryOrgContext(context: SentryOrgContext): void {
  // Gated separately: this writes the tenant independently of the user stamp,
  // so guarding only `setSentryIdentity` would leave a named org on an
  // otherwise-anonymous event while the switch is off.
  if (!isSentryIdentityEnabled()) return;
  const stamped = mergeUser(
    {
      org_id: context.orgId,
      ...(context.orgRole ? { org_role: context.orgRole } : {}),
      ...(context.membershipId ? { membership_id: context.membershipId } : {}),
    },
    ORG_KEYS,
  );
  // The tag is only worth asserting when the org was attached to an actual
  // actor. If the scope could not be read there is no user on the event, and a
  // tenant tag on it is a claim about nobody — the org it would name is not
  // evidence of who the event belongs to.
  if (!stamped) return;
  try {
    Sentry.setTag(ORG_ID_TAG, context.orgId);
  } catch (err) {
    console.warn(
      "[sentry-identity] could not stamp org tag:",
      err instanceof Error ? err.message : String(err),
    );
  }
  if (!context.orgRole) removeScopeAttributes(["org.role"]);
  if (!context.membershipId) removeScopeAttributes(["org.membership_id"]);
  setScopeAttributes({
    "org.id": context.orgId,
    ...(context.orgRole ? { "org.role": context.orgRole } : {}),
    ...(context.membershipId
      ? { "org.membership_id": context.membershipId }
      : {}),
  });
}

/**
 * Drop the acting identity. Needed on the client, where the isolation scope
 * outlives a sign-out: without this, events from the next anonymous session
 * on the same tab are attributed to whoever signed out last.
 */
export function clearSentryIdentity(): void {
  // Deliberately NOT gated. Clearing is always safe and always wanted: on the
  // client the isolation scope outlives a sign-out, so an unset switch must
  // never be the reason a previous user's identity survives on the scope.
  try {
    Sentry.setUser(null);
  } catch {
    // A sign-out must not fail because telemetry could not be cleared.
  }
  // The client isolation scope outlives the session, so the tenant tag would
  // otherwise survive the sign-out and file the next person's events against
  // the org of whoever was signed in before them.
  clearOrgTag();
  removeScopeAttributes([...USER_SCOPE_ATTRIBUTES, ...ORG_SCOPE_ATTRIBUTES]);
}
