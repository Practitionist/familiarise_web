# SSO Testing Guide

**Status**: Reference for local + CI testing
**Audience**: Engineers verifying SSO changes before production rollout
**Companion doc**: [08-sso-and-authentication.md](./08-sso-and-authentication.md)

## Why a dedicated testing guide

Real IdPs (Okta, Auth0, Azure AD, Google Workspace) require signup + admin configuration, which is expensive in iteration time. This guide lists four ways to exercise the SSO flow before handing a customer an app-setup URL. Work top-down — each approach catches bugs the one above cannot.

| # | Tool | Protocol | Setup | What it proves |
| -- | ---- | -------- | ----- | -------------- |
| 1 | `mocksaml.com` | SAML | Zero | BetterAuth parses IdP assertions; `customSession` auto-provisions a typed `Membership` row |
| 2 | `saml-idp` (npm) | SAML | 1 command | SP-initiated flow, cert rotation, attribute mapping |
| 3 | Keycloak (Docker) | SAML + OIDC | Docker Compose | OIDC PKCE verifier round-trip; most Okta-like |
| 4 | Auth0 / Okta dev tenant | OIDC / SAML | Free signup | Real-world IdP behavior before shipping to a customer |

---

## Prerequisites (all approaches)

- Dev server reachable at `NEXT_PUBLIC_APP_URL` (e.g. `http://localhost:3000`).
- A seeded org with `OWNER` access (the canonical `MemberRole` —
  Arch 4-Modified does not accept any legacy `ORG_*` aliases). For
  local dev run `npm run db:seed:small`.
- Visit `/dashboard/organization/<orgId>/settings/sso` and add the allowedEmailDomains + a provider in the UI. The Add Provider dialog shows the ACS/Redirect URI + SP Metadata URL the IdP needs — copy those into the IdP side of whichever tool you pick below.

---

## 1. mocksaml.com (fastest — no local infra)

mocksaml.com is a hosted fake SAML IdP maintained by BoxyHQ. Use it for a 60-second sanity check that the SAML response pipeline parses assertions and creates a session.

### Requirements

Your `NEXT_PUBLIC_APP_URL` must be publicly reachable so mocksaml can POST the SAML response back to our ACS. For localhost, use an `ngrok` / `localtunnel` / Cloudflare Tunnel URL as the app's `NEXT_PUBLIC_APP_URL`.

```bash
ngrok http 3000
# use the https:// URL in .env as NEXT_PUBLIC_APP_URL, restart dev server
```

### Provider config

In the Add Provider dialog, type:

- **Provider ID**: `mocksaml`
- **Domain**: `example.com`
- **Issuer**: `https://saml.example.com/entityid`
- **Provider type**: SAML
- **SSO entry point URL**: `https://mocksaml.com/api/saml/sso`
- **X.509 certificate**: paste from `https://mocksaml.com/api/saml/cert` (include BEGIN/END lines)

Save. Then go to `/auth/signin`, enter `alice@example.com`, blur the field — the "Sign in with <Org> SSO" button should appear. Click it. mocksaml will show its fake login form with a pre-filled email; click "Sign In". You should land on `/dashboard` with a created user + typed `Membership` row (auto-provisioned by the `customSession` hook in `lib/auth.ts`).

### What to verify

- [ ] Session cookie set; `useSession()` returns the new user.
- [ ] `Membership` row created with `role = defaultRoleForAutoJoin` (default `LEARNER`) for the org, bridged to the BetterAuth `Member` via `Membership.betterAuthMemberId`.
- [ ] `ssoEnforcementFailed` is false on the session (the user authenticated through a registered `ssoProvider.providerId`).

### Limits

- No PKCE exercise (SAML doesn't use PKCE). For OIDC PKCE go to step 3.
- mocksaml issues assertions from a fixed email — it can't simulate cert rotation or attribute-mapping edge cases.

---

## 2. saml-idp (local, no network required)

`saml-idp` is an npm CLI that spins a mock SAML IdP on your machine. Useful when you don't want tunnels and want to exercise cert rotation.

```bash
npx saml-idp \
  --acsUrl http://localhost:3000/api/auth/sso/saml2/sp/acs/local-idp \
  --audience http://localhost:3000/api/auth/sso/saml2/sp/metadata?providerId=local-idp
```

- Admin UI at `http://localhost:7000`. Download the IdP certificate and metadata from there.
- In the Add Provider dialog:
  - **Provider ID**: `local-idp`
  - **SSO entry point URL**: `http://localhost:7000/saml/sso`
  - **X.509 certificate**: the PEM block from the CLI output (or download from the admin UI)

Sign in from `/auth/signin`. Because the ACS target is already localhost, no tunnel is needed.

### What it catches that mocksaml doesn't

- Cert rotation: restart the CLI with `--cert /path/to/new.crt` and verify a stale provider config now fails with a SAML signature error (helps scope the "rotate cert" UX work deferred out of #672).
- `--config path/to/user.js` to override assertion attributes — exercises attribute mapping logic.

---

## 3. Keycloak via Docker (closest to real Okta/Azure — SAML + OIDC + PKCE)

Keycloak is the most realistic local IdP. It's the only free option that exercises OIDC PKCE end-to-end, which is the regression commit `b75fc96d` introduced (raw `fetch` skipped PKCE) and this PR fixes.

### Start Keycloak

```bash
docker run --name kc -p 8080:8080 \
  -e KEYCLOAK_ADMIN=admin \
  -e KEYCLOAK_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:latest start-dev
```

Open `http://localhost:8080/admin` and log in (admin/admin).

### Trusted-origins env override (required for local Keycloak)

BetterAuth 1.6.3 gates OIDC discovery URLs behind `trustedOrigins`. For production the IdP's host is usually on a public HTTPS domain already allowlisted; for local Keycloak you must add `http://localhost:8080` explicitly, otherwise `POST /api/auth/sign-in/sso` returns `400 discovery_untrusted_origin`.

Start the dev server with:

```bash
BETTER_AUTH_TRUSTED_ORIGINS="http://localhost:3000,http://localhost:8080" \
  npm run dev
```

Or amend the value in `.env` for the duration of the test.

### Create a test realm + user

1. Top-left realm selector → Create realm → name it `familiarise-test`.
2. Users → Add user → Username `alice`, Email `alice@example.com`, Email verified ON → Create. Set a password under "Credentials" (turn Temporary OFF).

### Option A: OIDC client (recommended — tests PKCE)

1. Clients → Create client → Client type **OpenID Connect**, Client ID `familiarise-oidc` → Next.
2. Capability config: Client authentication **ON**, Standard flow **ON** → Next.
3. Login settings:
   - **Valid redirect URIs** = the Redirect URI our Add Provider dialog shows (`http://localhost:3000/api/auth/sso/callback/kc-oidc`).
   - **Web origins** = `http://localhost:3000`.
4. Save. Credentials tab → copy the Client Secret.
5. Advanced tab → find "Proof Key for Code Exchange Code Challenge Method" → set to **S256**. This is the switch that forces Keycloak to reject non-PKCE requests (so our test is meaningful).
6. In Familiarise → Add Provider:
   - **Provider ID** = `kc-oidc`
   - **Domain** = `example.com`
   - **Issuer** = `http://localhost:8080/realms/familiarise-test`
   - **Provider type** = OIDC
   - **Client ID** = `familiarise-oidc`, **Client Secret** = from step 4
   - **Discovery URL** = `http://localhost:8080/realms/familiarise-test/.well-known/openid-configuration`

### Option B: SAML client

1. Clients → Create client → Client type **SAML**, Client ID = the SP Metadata URL our dialog shows → Next.
2. Settings:
   - **Valid redirect URIs** = the ACS URL our dialog shows.
   - **Master SAML Processing URL** = the ACS URL.
3. Keys tab → download the IdP certificate.
4. Realm settings → General → SAML 2.0 Identity Provider Metadata (link) → open the XML, copy `<SingleSignOnService Location="…">` for the entry point.
5. In Familiarise → Add Provider with SAML, pasting the cert and entry point.

### PKCE verification (OIDC path)

This is the specific regression test for this PR:

1. Start dev server, log in at `/auth/signin` with `alice@example.com`.
2. Open DevTools → Network tab, filter to "sso".
3. Click "Sign in with <Org> SSO".
4. Look at the redirect to Keycloak's `/auth` endpoint. The URL **must** include:
   - `code_challenge=<43+ char base64url>`
   - `code_challenge_method=S256`
5. If those query params are missing, `ssoClient()` isn't wired or the signin page is still doing raw `fetch` — re-check `lib/auth-client.ts` and `app/auth/signin/page.tsx`.
6. Complete the Keycloak login. You should land on `/dashboard`.

---

## 4. Auth0 / Okta free dev tenants (real-world signoff)

Both tenants are free and persistent. Use them when Keycloak is green and you need a last mile check against a provider real customers actually use.

- **Auth0**: follow [docs/enterprise/08-sso-and-authentication.md § Auth0 — OIDC](./08-sso-and-authentication.md#auth0--oidc). The trailing slash on `issuer` is load-bearing.
- **Okta Developer Edition**: sign up at `developer.okta.com`. Use the [Okta SAML recipe in the main doc](./08-sso-and-authentication.md#okta--saml).

Only do this before cutting a customer a signup link — don't burn cycles here during active development.

---

## What each fix in this PR is verifiable against

| Fix | Testable via | How to tell it's working |
| --- | ------------ | ------------------------ |
| `ssoClient()` registered + `signIn.sso()` on signin/signup | Keycloak OIDC (step 3) | `code_challenge` + `S256` in the IdP redirect URL |
| `ssoProvider.userId` null | Any IdP (step 1 is enough) | `SELECT userId FROM ssoProvider WHERE providerId='...'` → null |
| Precise OAuth bypass check | Any IdP + a password user | Create a user on an `enforceSSO=true` domain via password. Session's `ssoEnforcementFailed` should be `true`. Link Google OAuth — still `true`. Only when `account.providerId` matches a registered `ssoProvider.providerId` should it flip to `false`. |
| `callbackUrl` removed from SAML form | UI visual | Add Provider dialog for SAML has **no** callback URL input; ACS URL card is shown read-only |
| ACS/Metadata URL surfaced | UI visual | Add Provider dialog + provider list row show the URLs with working copy buttons |
| "OIDC coming soon" removed | UI visual | Subtitle reads "Configure SAML or OIDC sign-in for this organization" |

---

## Common failure modes

| Symptom | Likely cause |
| ------- | ------------ |
| IdP shows "InvalidRequest: redirect_uri mismatch" | IdP's allowlisted redirect URI differs from our derived one. Copy from the dialog verbatim — paths are case-sensitive. |
| "InResponseTo mismatch" at SAML callback | Session lost between the AuthnRequest and the response (e.g. `sameSite=strict` cookie dropped). Check Network tab for the `better-auth.state` cookie. |
| OIDC callback fails with "code_verifier missing" | `ssoClient()` plugin not registered in `lib/auth-client.ts`, or the signin page is calling raw `fetch` instead of `signIn.sso()`. |
| Typed `Membership` row not created after first SSO login | `customSession` sync only runs on session load — visit `/dashboard` once after the SSO redirect lands. Check the `member` row exists; if it does but the typed sibling doesn't, the sync is failing. Check server logs. |
| ssoProvider row FK-cascades when admin deactivates owner | `userId` was set on row creation. This PR leaves `userId` null; re-check the `create` call in `providers/route.ts`. |

---

## CI / automated test gaps (follow-up)

These are deferred out of this PR but worth tracking:

- No Playwright / Cypress test for the SSO redirect flow (would need mocksaml or a test-only BetterAuth `defaultSSO` config).
- `ssoProvider` rows have no migration to re-null `userId` on pre-existing data — if any row predates this PR, manually run `UPDATE ssoProvider SET userId = NULL WHERE organizationId IS NOT NULL;`.
- No alerting on SAML cert expiry. BetterAuth fails loudly at assertion time, but a proactive check would be nicer.
