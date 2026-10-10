/**
 * @jest-environment node
 */

/**
 * IdP claim checks run in the SSO account hooks on every login, before any
 * session exists: the IdP must vouch for the email, Google must assert a
 * covered `hd`, and Entra's `xms_edov` must be true when it is sent. A refused
 * first login removes only the user row that callback created.
 */

const providerFindUnique = jest.fn(async (_a: unknown) => ({
  domain: "acme.co.in,acme.com",
}));
const userDeleteMany = jest.fn(async (_a: unknown) => ({ count: 1 }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    ssoProvider: { findUnique: (a: unknown) => providerFindUnique(a) },
    user: { deleteMany: (a: unknown) => userDeleteMany(a) },
  },
}));
const deleteSubscriber = jest.fn(async (_id: string) => true);
jest.mock("../../lib/novu/subscriber", () => ({
  deleteSubscriber: (id: string) => deleteSubscriber(id),
}));
const provisionSsoMembership = jest.fn();
jest.mock("../../lib/sso/jit-membership", () => ({
  provisionSsoMembership: (a: unknown) => provisionSsoMembership(a),
}));
const stampProviderProven = jest.fn();
jest.mock("../../lib/sso/provider-proof", () => ({
  stampProviderProven: (a: unknown) => stampProviderProven(a),
}));

import {
  assertIdpClaims,
  decodeIdTokenClaims,
  type IdTokenClaims,
} from "@/lib/sso/idp-claims";
import { ssoPluginOptions } from "@/lib/sso/plugin-options";
import {
  assertSsoAccountClaims,
  discardUnfinishedSsoUser,
} from "@/lib/sso/account-claims";

const COVERED = ["acme.com", "acme.co.in"];

function idToken(claims: Record<string, unknown>): string {
  const b64 = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64({ sub: "sub-1", ...claims })}.sig`;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as { body?: { code?: string } }).body?.code;
  }
  return undefined;
}

function claims(extra: Partial<IdTokenClaims>): IdTokenClaims {
  return { iss: "https://idp.acme.com", sub: "sub-1", ...extra };
}

describe("assertIdpClaims", () => {
  const GOOGLE = "https://accounts.google.com";
  const ENTRA = "https://login.microsoftonline.com/tid/v2.0";

  it.each([true, "true"])(
    "accepts a generic IdP with email_verified=%p",
    (v) => {
      expect(
        codeOf(() => assertIdpClaims(claims({ email_verified: v }), COVERED)),
      ).toBeUndefined();
    },
  );

  it.each([false, "false", undefined])(
    "refuses a generic IdP with email_verified=%p",
    (v) => {
      expect(
        codeOf(() => assertIdpClaims(claims({ email_verified: v }), COVERED)),
      ).toBe("SSO_EMAIL_NOT_VERIFIED");
    },
  );

  it("accepts Google Workspace with a covered hd", () => {
    const c = claims({ iss: GOOGLE, email_verified: true, hd: "acme.co.in" });
    expect(codeOf(() => assertIdpClaims(c, COVERED))).toBeUndefined();
  });

  it.each([undefined, "evil.com"])(
    "refuses Google with hd=%p (a personal or foreign account)",
    (hd) => {
      const c = claims({ iss: GOOGLE, email_verified: true, hd });
      expect(codeOf(() => assertIdpClaims(c, COVERED))).toBe(
        "SSO_HOSTED_DOMAIN_MISMATCH",
      );
    },
  );

  it.each([true, 1, "1"])("accepts Entra with xms_edov=%p", (v) => {
    const c = claims({ iss: ENTRA, xms_edov: v });
    expect(codeOf(() => assertIdpClaims(c, COVERED))).toBeUndefined();
  });

  it("refuses Entra with xms_edov=false even if email_verified is true", () => {
    const c = claims({ iss: ENTRA, xms_edov: false, email_verified: true });
    expect(codeOf(() => assertIdpClaims(c, COVERED))).toBe(
      "SSO_EMAIL_NOT_VERIFIED",
    );
  });

  it("refuses Entra that sends neither xms_edov nor email_verified", () => {
    expect(codeOf(() => assertIdpClaims(claims({ iss: ENTRA }), COVERED))).toBe(
      "SSO_EMAIL_NOT_VERIFIED",
    );
  });
});

describe("decodeIdTokenClaims", () => {
  it("reads the payload of a verified id_token", () => {
    expect(
      decodeIdTokenClaims(
        idToken({ iss: "https://idp", email_verified: true }),
      ),
    ).toMatchObject({ iss: "https://idp", sub: "sub-1", email_verified: true });
  });

  it.each([undefined, "not-a-jwt", "a.%%%.c"])(
    "refuses a missing or unreadable token (%p)",
    (token) => {
      expect(codeOf(() => decodeIdTokenClaims(token))).toBe(
        "SSO_ID_TOKEN_MISSING",
      );
    },
  );
});

describe("assertSsoAccountClaims", () => {
  beforeEach(() => jest.clearAllMocks());

  it("accepts a verified identity on a covered domain", async () => {
    await expect(
      assertSsoAccountClaims({
        providerId: "oidc-acme",
        idToken: idToken({ iss: "https://idp.acme.com", email_verified: true }),
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses an unverified email from the id_token being stored", async () => {
    await expect(
      assertSsoAccountClaims({
        providerId: "oidc-acme",
        idToken: idToken({
          iss: "https://idp.acme.com",
          email_verified: false,
        }),
      }),
    ).rejects.toMatchObject({ body: { code: "SSO_EMAIL_NOT_VERIFIED" } });
  });

  it("refuses an account write with no id_token", async () => {
    await expect(
      assertSsoAccountClaims({ providerId: "oidc-acme", idToken: null }),
    ).rejects.toMatchObject({ body: { code: "SSO_ID_TOKEN_MISSING" } });
  });
});

describe("discardUnfinishedSsoUser", () => {
  beforeEach(() => jest.clearAllMocks());

  it("deletes only a fresh user with no account and no session", async () => {
    await discardUnfinishedSsoUser("u_new");
    expect(userDeleteMany).toHaveBeenCalledWith({
      where: {
        id: "u_new",
        accounts: { none: {} },
        sessions: { none: {} },
        createdAt: { gt: expect.any(Date) },
      },
    });
    expect(deleteSubscriber).toHaveBeenCalledWith("u_new");
  });

  it("leaves an established user alone", async () => {
    userDeleteMany.mockResolvedValueOnce({ count: 0 });
    await discardUnfinishedSsoUser("u_existing");
    expect(deleteSubscriber).not.toHaveBeenCalled();
  });
});

describe("provisionUser", () => {
  const provider = {
    providerId: "oidc-acme",
    organizationId: "org_1",
    domain: "acme.co.in,acme.com",
  };
  const user = { id: "u_1", email: "asha@acme.co.in" };

  beforeEach(() => {
    jest.clearAllMocks();
    provisionSsoMembership.mockResolvedValue({
      kind: "joined",
      organizationId: "org_1",
      role: "LEARNER",
    });
  });

  it("joins the org and offers the login as provider proof", async () => {
    await ssoPluginOptions.provisionUser({
      user,
      userInfo: {},
      token: {},
      provider,
    } as unknown as Parameters<typeof ssoPluginOptions.provisionUser>[0]);
    expect(provisionSsoMembership).toHaveBeenCalledWith({
      userId: "u_1",
      email: "asha@acme.co.in",
      providerId: "oidc-acme",
      organizationId: "org_1",
    });
    expect(stampProviderProven).toHaveBeenCalledWith({
      providerId: "oidc-acme",
      organizationId: "org_1",
      userId: "u_1",
    });
  });
});
