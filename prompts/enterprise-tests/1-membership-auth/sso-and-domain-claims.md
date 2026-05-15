# 1-membership-auth — SSO + domain claims

> **Required reading:** [`_shared/shared-setup.md`](../_shared/shared-setup.md),
> [`_shared/mcp-recipes.md`](../_shared/mcp-recipes.md),
> [`_shared/case-template.md`](../_shared/case-template.md).
> Apply the **fix-and-retest gate** when any case fails.

**Surface(s) under test:**
- `app/api/organizations/[orgId]/sso/route.ts` (provider CRUD)
- `app/api/organizations/[orgId]/domain-claims/route.ts` (DNS TXT verify)
- `lib/sso/derive-urls.ts` — `deriveAcsUrl`, `deriveMetadataUrl`
- `lib/sso/provider-schemas.ts` — Zod bodies
- `lib/sso/enforce-session.ts` — `shouldRejectSession` (custom-session hook)
- `app/dashboard/organization/[orgId]/settings/sso/page.tsx` — wizard UI

**Case roster:**
1. **SSO.1** — Create SAML provider (happy)
2. **SSO.2** — `deriveAcsUrl` / `deriveMetadataUrl` round-trip in response body
3. **SSO.3** — Create domain claim, verify status pending
4. **SSO.4** — Enforce SSO: non-SSO sign-in to enforced org → 403 via `shouldRejectSession`
5. **SSO.5** — UI: settings/sso page renders config inputs + status

---

## Common preconditions

Use Wipro (or spawn a fresh sponsor org). OWNER session required.

Cleanup at end:
```sql
DELETE FROM "ssoProvider" WHERE "organizationId" = '<wipro-id>'
  AND "issuer" LIKE '%test-sso%';
DELETE FROM "org_domain_claims" WHERE "organizationId" = '<wipro-id>'
  AND domain LIKE '%test-sso%';
```

---

## SSO.1: Create SAML provider

```js
() => fetch("/api/organizations/<wipro-id>/sso", {
  method: "POST", credentials: "include",
  headers: {"Content-Type": "application/json"},
  body: JSON.stringify({
    providerId: "test-sso-okta",
    issuer: "https://test-sso.okta.com",
    samlConfig: {
      entryPoint: "https://test-sso.okta.com/sso/saml",
      cert: "<base64-cert>",
      callbackUrl: "" // server fills via deriveAcsUrl
    }
  })
}).then(async r => ({ status: r.status, body: await r.json() }))
```

### Assertions
- `status === 201`
- `body.data.callbackUrl` matches `deriveAcsUrl(orgSlug)` shape
  (typically `https://<host>/api/auth/sso/saml/<providerId>/callback`).
- DB `ssoProvider` row exists.
- Audit: `SSO_PROVIDER_CONFIGURED`.

---

## SSO.2: URL derivation in response

Inspect `body.data` for both `callbackUrl` (ACS) and `metadataUrl`.

```ts
mcp__chrome-devtools__evaluate_script({
  function: `() => fetch("/api/organizations/<wipro-id>/sso").then(async r => (await r.json()).data)`
})
// Assert returned URLs match deriveAcsUrl/deriveMetadataUrl output
// (verify against lib/sso/derive-urls.ts contract)
```

---

## SSO.3: Domain claim

```js
() => fetch("/api/organizations/<wipro-id>/domain-claims", {
  method: "POST", credentials: "include",
  headers: {"Content-Type": "application/json"},
  body: JSON.stringify({ domain: "test-sso.example" })
}).then(async r => ({ status: r.status, body: await r.json() }))
```

### Assertions
- `status === 201`
- `body.data.verificationToken` is a string (DNS TXT record value).
- `body.data.verifiedAt === null`.
- DB row in `org_domain_claims` with `verified_at IS NULL`.

Verification requires the user to add the TXT record; do not auto-verify
in tests unless you can mock DNS. Document the pending state.

---

## SSO.4: Enforce SSO + non-SSO sign-in

Update org settings to `enforceSso = true` with the domain claim from
SSO.3 (or via the SSO provider's `allowedEmailDomains`).

Attempt regular email-password sign-in for `someone@test-sso.example`
without going through the SSO provider.

### Assertions
- The session is rejected via `lib/sso/enforce-session.ts:shouldRejectSession`.
- API returns 403 or the session cookie is rotated and the user lands on
  a "Use SSO to sign in" page.

Edge case: a `users` row whose email matches the enforced domain but
who has no `Account` linked to any `SsoProvider.providerId` is the
exact case `shouldRejectSession` is designed for. Verify by reading the
helper's branch logic at `lib/auth.ts:497`.

---

## SSO.5: UI — settings/sso wizard

`navigate_page("http://localhost:3000/dashboard/organization/<wipro-id>/settings/sso")`.

`take_snapshot`. Expected fields:
- Provider id input
- Issuer / entry point
- Cert paste box
- Read-only ACS URL + metadata URL boxes (derived after save)
- Domain claims list with verification status pill

Submitting via UI hits the same `POST /api/organizations/<orgId>/sso`
route — assert DB matches SSO.1.
