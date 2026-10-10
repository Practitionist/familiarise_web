/**
 * @jest-environment node
 */

/**
 * One real OIDC round trip through @better-auth/sso, against a live mock IdP.
 *
 * Real: HTTP to oauth2-mock-server for discovery (through the app's own
 * registration-time `discoverOidcConfigForTenant`), the browser hop to
 * /authorize, the code-for-token exchange with PKCE, JWKS fetch and ID-token
 * signature/issuer/audience verification, userinfo, BetterAuth's state
 * cookie, user/account/session creation, the session cookie, and the
 * production sso() options from lib/sso/plugin-options.ts, including the
 * `provisionUser` JIT hook running the real `provisionSsoMembership`.
 *
 * Not real, and why:
 * - BetterAuth's memory adapter replaces prismaAdapter (no database in jest),
 *   so Prisma-level behaviour (unique constraints, the SsoProvider secret
 *   encryption extension) and lib/auth.ts's other plugins and databaseHooks
 *   (SSO enforcement veto, welcome email, customSession) are not exercised.
 *   Only its email-domain check is wired in, the way lib/auth.ts calls it.
 * - The JIT module's own Prisma calls hit a small in-memory fake, and
 *   `applyMembershipRoleEffects` is stubbed; the gate logic itself has unit
 *   coverage in jit-membership.test.ts.
 * - The mock IdP listens on localhost, so the SSRF guard on registration is
 *   stubbed and the IdP origin is added to `trustedOrigins` (the plugin only
 *   dials private hosts that are allowlisted).
 */

import { generateKeyPair, exportJWK } from "jose";
import { OAuth2Server } from "oauth2-mock-server";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { sso } from "@better-auth/sso";

type MembershipRow = {
  userId: string;
  organizationId: string;
  role: string;
  status: string;
};
const memberships: MembershipRow[] = [];
const fakePrisma = {
  membership: {
    findUnique: async ({
      where,
    }: {
      where: {
        userId_organizationId: { userId: string; organizationId: string };
      };
    }) => {
      const key = where.userId_organizationId;
      return (
        memberships.find(
          (m) =>
            m.userId === key.userId && m.organizationId === key.organizationId,
        ) ?? null
      );
    },
    count: async () => memberships.length,
    findFirst: async () => null,
    create: async ({ data }: { data: MembershipRow }) => {
      memberships.push(data);
      return data;
    },
  },
  organization: {
    findUnique: async () => ({ status: "ACTIVE", ssoSettings: null }),
  },
  orgDomainClaim: {
    findFirst: async ({ where }: { where: { domain: string } }) =>
      where.domain === "acme.test" ? { id: "claim_1" } : null,
  },
  invitation: { findFirst: async () => null },
  orgAuditLog: { create: async () => ({}), findFirst: async () => null },
  account: {
    deleteMany: async ({
      where,
    }: {
      where: { userId: string; providerId: string };
    }) => {
      const before = db.account.length;
      db.account = db.account.filter(
        (a) =>
          !(a.userId === where.userId && a.providerId === where.providerId),
      );
      return { count: before - db.account.length };
    },
  },
  ssoProvider: {
    findUnique: async ({ where }: { where: { providerId: string } }) =>
      db.ssoProvider.find((p) => p.providerId === where.providerId) ?? null,
    updateMany: async () => ({ count: 0 }),
  },
  $transaction: async (fn: (tx: unknown) => unknown) => fn(fakePrisma),
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return fakePrisma;
  },
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemEvent: jest.fn(async () => {}),
}));
jest.mock("../../lib/enterprise/outbound-webhooks/dispatch", () => ({
  dispatchWebhookEvent: jest.fn(async () => undefined),
}));
jest.mock("../../lib/api/organizations/membership-transitions", () => ({
  applyMembershipRoleEffects: async () => ({
    consulteeProfileId: "consultee_1",
    consultantProfileId: null,
    payoutRecipient: "SELF",
  }),
}));
jest.mock("../../lib/enterprise/outbound-webhooks/ssrf-guard", () => ({
  ...jest.requireActual("../../lib/enterprise/outbound-webhooks/ssrf-guard"),
  assertPublicUrl: async () => {},
}));

import { ssoPluginOptions } from "@/lib/sso/plugin-options";
import {
  assertSsoEmailOnDomain,
  isSsoProviderId,
} from "@/lib/sso/account-domain";
import {
  buildStoredOidcConfig,
  discoverOidcConfigForTenant,
} from "@/lib/sso/oidc-discovery";

const APP = "http://localhost:3000";
const CLIENT_ID = "familiarise-test";
const ORG_ID = "org_acme";
const PROVIDER_ID = "oidc-acme";
const IDP_USER = { sub: "idp-user-1", email: "asha@acme.test", name: "Asha" };
let idpUser = IDP_USER;
let emailVerified = true;

type Db = Record<string, Record<string, unknown>[]>;
type CookieJar = Map<string, string>;

function storeCookies(res: Response, jar: CookieJar) {
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}
const cookieHeader = (jar: CookieJar) =>
  [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

let idp: OAuth2Server;
let issuer: string;
let db: Db;
let auth: ReturnType<typeof buildAuth>;

function buildAuth() {
  return betterAuth({
    secret: "test-secret-that-is-at-least-32-characters",
    baseURL: APP,
    trustedOrigins: [issuer],
    database: memoryAdapter(db),
    plugins: [sso(ssoPluginOptions)],
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            if (ctx?.path?.startsWith("/sso/")) {
              await assertSsoEmailOnDomain(ctx.params?.providerId, user.email);
            }
          },
        },
      },
      account: {
        create: {
          before: async (account, ctx) => {
            if (!isSsoProviderId(account.providerId)) return;
            // Through the adapter: the user row may only exist inside the
            // callback's transaction so far.
            const user = await ctx?.context.internalAdapter.findUserById(
              account.userId,
            );
            await assertSsoEmailOnDomain(account.providerId, user?.email);
          },
        },
      },
    },
  });
}

async function signInThroughIdp(providerId = PROVIDER_ID) {
  const jar: CookieJar = new Map();
  const start = await auth.handler(
    new Request(`${APP}/api/auth/sign-in/sso`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP },
      body: JSON.stringify({ providerId, callbackURL: "/dashboard" }),
    }),
  );
  storeCookies(start, jar);
  return { start, jar };
}

async function completeRoundTrip() {
  const { start, jar } = await signInThroughIdp();
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };

  // The browser hop: the mock IdP "logs the user in" and redirects back.
  const authorize = await fetch(url, { redirect: "manual" });
  expect(authorize.status).toBe(302);
  const callback = authorize.headers.get("location")!;
  expect(
    callback.startsWith(`${APP}/api/auth/sso/callback/${PROVIDER_ID}`),
  ).toBe(true);

  const done = await auth.handler(
    new Request(callback, { headers: { cookie: cookieHeader(jar) } }),
  );
  storeCookies(done, jar);
  return { authorizeUrl: new URL(url), done, jar };
}

beforeAll(async () => {
  idp = new OAuth2Server();
  // Added rather than `keys.generate()`d: the generated JWK fails the mock's
  // plain-object check across jest's VM realm boundary.
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  await idp.issuer.keys.add({
    ...(await exportJWK(privateKey)),
    alg: "RS256",
    kid: "test-key",
  });
  await idp.start(0, "localhost");
  issuer = idp.issuer.url!;

  idp.service.on(
    "beforeTokenSigning",
    (token: { payload: Record<string, unknown> }) => {
      Object.assign(token.payload, {
        ...idpUser,
        email_verified: emailVerified,
        aud: CLIENT_ID,
      });
    },
  );
  idp.service.on(
    "beforeUserinfo",
    (res: { body: Record<string, unknown>; statusCode: number }) => {
      res.body = { ...idpUser, email_verified: true };
    },
  );
});

afterAll(async () => {
  await idp.stop();
});

beforeEach(async () => {
  idpUser = IDP_USER;
  emailVerified = true;
  memberships.length = 0;
  db = {
    user: [],
    session: [],
    account: [],
    verification: [],
    ssoProvider: [],
  };

  // Registered the way POST /api/organizations/[orgId]/sso/providers stores
  // it, then approved (domainVerified) the way the staff door does.
  const discoveryEndpoint = `${issuer}/.well-known/openid-configuration`;
  const discovered = await discoverOidcConfigForTenant(
    issuer,
    discoveryEndpoint,
  );
  db.ssoProvider.push({
    id: "row_1",
    providerId: PROVIDER_ID,
    issuer,
    domain: "acme.test",
    organizationId: ORG_ID,
    userId: null,
    domainVerified: true,
    oidcConfig: JSON.stringify(
      buildStoredOidcConfig({
        issuer,
        clientId: CLIENT_ID,
        clientSecret: "client-secret",
        discoveryEndpoint,
        discovered,
      }),
    ),
  });
  auth = buildAuth();
});

it("signs a user in through the IdP, creates the session and JIT-joins the org", async () => {
  const { authorizeUrl, done, jar } = await completeRoundTrip();

  expect(authorizeUrl.origin).toBe(issuer);
  expect(authorizeUrl.searchParams.get("client_id")).toBe(CLIENT_ID);
  expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");

  expect(done.status).toBe(302);
  expect(done.headers.get("location")).toBe("/dashboard");
  expect(jar.get("better-auth.session_token")).toBeTruthy();

  const [user] = db.user;
  expect(user).toMatchObject({ email: IDP_USER.email, name: IDP_USER.name });
  expect(db.account).toEqual([
    expect.objectContaining({
      providerId: PROVIDER_ID,
      accountId: IDP_USER.sub,
      userId: user.id,
    }),
  ]);
  expect(db.session).toHaveLength(1);

  // The cookie is a working session, not just a row.
  const session = await auth.handler(
    new Request(`${APP}/api/auth/get-session`, {
      headers: { cookie: cookieHeader(jar) },
    }),
  );
  expect(await session.json()).toMatchObject({
    user: { id: user.id, email: IDP_USER.email },
  });

  expect(memberships).toEqual([
    {
      userId: user.id,
      organizationId: ORG_ID,
      role: "LEARNER",
      status: "ACTIVE",
      consulteeProfileId: "consultee_1",
      consultantProfileId: null,
      payoutRecipient: "SELF",
    },
  ]);
});

it("re-login reuses the user and account and does not duplicate the membership", async () => {
  await completeRoundTrip();
  const { done } = await completeRoundTrip();

  expect(done.status).toBe(302);
  expect(db.user).toHaveLength(1);
  expect(db.account).toHaveLength(1);
  expect(db.session).toHaveLength(2);
  expect(memberships).toHaveLength(1);
});

it("refuses to start sign-in through a provider staff have not approved", async () => {
  db.ssoProvider[0].domainVerified = false;

  const { start } = await signInThroughIdp();

  expect(start.status).toBe(401);
  expect(db.session).toHaveLength(0);
  expect(memberships).toHaveLength(0);
});

it("refuses an IdP that asserts an email outside the provider's domain", async () => {
  idpUser = { ...IDP_USER, email: "victim@gmail.test" };

  const { done, jar } = await completeRoundTrip();

  expect(done.status).toBe(302);
  expect(done.headers.get("location")).toContain(
    "error=SSO_EMAIL_DOMAIN_MISMATCH",
  );
  expect(jar.get("better-auth.session_token")).toBeUndefined();
  expect(db.user).toHaveLength(0);
  expect(db.account).toHaveLength(0);
  expect(memberships).toHaveLength(0);
});

it("never links an out-of-domain IdP account to an existing user", async () => {
  db.user.push({
    id: "victim",
    email: "victim@gmail.test",
    emailVerified: true,
    name: "Victim",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  idpUser = { ...IDP_USER, email: "victim@gmail.test" };

  const { done } = await completeRoundTrip();

  expect(done.status).toBe(302);
  expect(done.headers.get("location")).toContain("error=");
  expect(db.account).toHaveLength(0);
  expect(db.session).toHaveLength(0);
});

it("refuses an identity the IdP does not mark email_verified, leaving no link or cookie", async () => {
  emailVerified = false;

  const { done, jar } = await completeRoundTrip();

  expect(done.status).toBe(403);
  expect(await done.json()).toMatchObject({ code: "SSO_EMAIL_NOT_VERIFIED" });
  expect(jar.get("better-auth.session_token")).toBeUndefined();
  expect(db.account).toHaveLength(0);
  expect(memberships).toHaveLength(0);
});
