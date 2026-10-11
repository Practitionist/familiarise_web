import { APIError } from "better-auth/api";
import { z } from "zod";

const GOOGLE_ISSUERS = new Set([
  "https://accounts.google.com",
  "accounts.google.com",
]);
const ENTRA_HOSTS = new Set(["login.microsoftonline.com", "sts.windows.net"]);

const flag = z.union([z.boolean(), z.string(), z.number()]).optional();

const IdTokenClaimsSchema = z
  .object({
    iss: z.string(),
    sub: z.string(),
    email_verified: flag,
    hd: z.string().optional(),
    xms_edov: flag,
  })
  .passthrough();

export type IdTokenClaims = z.infer<typeof IdTokenClaimsSchema>;

function isTrue(value: IdTokenClaims["email_verified"]): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function issuerHost(iss: string): string | null {
  try {
    return new URL(iss).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function refuse(code: string, message: string): never {
  throw new APIError("FORBIDDEN", { code, message });
}

/** Payload of an id_token the sso() plugin has already verified (iss, aud, signature). */
export function decodeIdTokenClaims(
  idToken: string | undefined,
): IdTokenClaims {
  const payload = idToken?.split(".")[1];
  if (!payload) {
    refuse(
      "SSO_ID_TOKEN_MISSING",
      "Your identity provider did not return an ID token.",
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    json = null;
  }
  const parsed = IdTokenClaimsSchema.safeParse(json);
  if (!parsed.success) {
    refuse(
      "SSO_ID_TOKEN_MISSING",
      "Your identity provider returned an unreadable ID token.",
    );
  }
  return parsed.data;
}

/**
 * Refuses identities whose email the IdP does not vouch for: `email_verified`
 * must be true; Google (a multi-tenant issuer) must assert `hd` as a covered
 * domain; Entra uses `xms_edov`, which must be true when present.
 */
export function assertIdpClaims(
  claims: IdTokenClaims,
  coveredDomains: readonly string[],
): void {
  const host = issuerHost(claims.iss);

  if (host && ENTRA_HOSTS.has(host)) {
    const verified =
      claims.xms_edov !== undefined
        ? isTrue(claims.xms_edov)
        : isTrue(claims.email_verified);
    if (!verified) {
      refuse(
        "SSO_EMAIL_NOT_VERIFIED",
        "Your organization's Microsoft Entra tenant did not confirm this email address (xms_edov).",
      );
    }
    return;
  }

  if (!isTrue(claims.email_verified)) {
    refuse(
      "SSO_EMAIL_NOT_VERIFIED",
      "Your identity provider did not confirm this email address.",
    );
  }

  if (GOOGLE_ISSUERS.has(claims.iss)) {
    const hd = claims.hd?.toLowerCase();
    if (!hd || !coveredDomains.includes(hd)) {
      refuse(
        "SSO_HOSTED_DOMAIN_MISMATCH",
        "Sign in with your organization's Google Workspace account, not a personal Google account.",
      );
    }
  }
}
