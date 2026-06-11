import { createAuthClient } from "better-auth/react";
import { customSessionClient } from "better-auth/client/plugins";
import { ssoClient } from "@better-auth/sso/client";
import type { auth } from "@/lib/auth";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL,
  // ssoClient exposes authClient.signIn.sso(), which generates the OIDC PKCE
  // code_verifier/code_challenge pair and persists the verifier so the
  // callback can validate it. A raw POST to /api/auth/sign-in/sso would
  // skip PKCE entirely and break Auth0 / Okta OIDC / Azure AD OIDC flows.
  plugins: [customSessionClient<typeof auth>(), ssoClient()],
});

export const { signIn, signUp, signOut, useSession, getSession } = authClient;
