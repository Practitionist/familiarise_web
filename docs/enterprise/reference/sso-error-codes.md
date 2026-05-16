# SSO error codes — reference

> **Scope.** Every typed HTTP error code emitted by the SSO + auth
> routes, what it means, and the operator-facing message
> `lib/labels/org-errors.ts:humanizeOrgError` surfaces.
>
> **Audience.** Anyone debugging a failed SSO flow, anyone writing
> test prompts that need to assert on error codes, anyone adding a
> new typed error in the SSO surface.

---

## §1 — Reference table

| Code | HTTP | Route(s) | Humanized message | Typical cause / fix |
|---|---|---|---|---|
| `SSO_REQUIRED` | 403 | session creation (any path) | "This email domain requires SSO sign-in. Please use your organization's SSO provider at /auth/signin." | User tried email+password on an enforced domain. Direct them to the SSO button. |
| `DOMAIN_NOT_OWNED` | 422 | `POST /organizations/[orgId]/sso/providers` | "Domain '...' is not claimed by this organization. Claim and verify the domain first under Settings → SSO → Domains." | Admin pasted a domain that another org owns, or never claimed at all. |
| `DOMAIN_NOT_VERIFIED` | 422 | `POST /organizations/[orgId]/sso/providers` | "Domain '...' is claimed but not yet verified. Add the required DNS TXT record and complete verification before registering an SSO provider." | Admin claimed the domain but hasn't proven ownership via DNS yet. |
| `DOMAIN_ALREADY_REGISTERED` | 409 | `POST /organizations/[orgId]/sso/providers` | "Domain '...' is already registered with another provider for this org." | Two providers for the same domain (e.g. Okta + Auth0 race). Pick one. |
| `PROVIDERID_TAKEN` | 409 | `POST /organizations/[orgId]/sso/providers` | "providerId '...' is already in use. Pick a globally-unique slug." | `SsoProvider.providerId` is globally unique (BetterAuth uses it as the URL slug). |
| `ROLE_TRANSITION_BLOCKED` | 409 | `POST /members`, `PATCH /members/[memberId]` | "This role change is not allowed — remove the member and re-add with the new role." | LEARNER ↔ EXPERT direct transition. See `lib/enterprise/role-transitions.ts`. |
| `ORG_NOT_VERIFIED` | 409 | revenue routes (wallet top-up, invoice issue, payout) | "Your organization is awaiting verification. Revenue actions are blocked until an admin verifies the workspace." | PENDING_VERIFICATION org tried to do money. Admin must POST `/admin/.../verify`. |
| `LAST_OWNER_GUARD` | 409 | `PATCH /members/[memberId]`, `DELETE /members/[memberId]` | "Cannot remove the only active OWNER. Promote another member first." | Self-protection. |
| `INVALID_X509_CERT` | 400 | `POST /organizations/[orgId]/sso/providers` | (from Zod) "Invalid X.509 certificate. Paste the PEM block from your IdP — it should start with -----BEGIN CERTIFICATE----- and end with -----END CERTIFICATE-----." | Cert pasted is not a valid PEM. Re-export from the IdP's admin console. |
| `INVALID_DEFAULT_ROLE` | 400 | `PATCH /organizations/[orgId]/sso` | (from Zod) "Invalid input — defaultRoleForAutoJoin must be 'LEARNER'." | Audit A.1. Only `LEARNER` is accepted; admins promote explicitly. |
| `PROGRAM_TYPE_NOT_AVAILABLE` | 400 | `POST /organizations/[orgId]/programs` | "Programs v2 (PROJECT/RETAINER) is not yet available; track readiness in #703." | Cross-link: out-of-scope feature. See `prompts/enterprise-tests/2-programs-contracts/2.3-programs-v2-rejection.md`. |

(Codes shipped by this audit batch in **bold-equivalent** italics:
`DOMAIN_NOT_OWNED`, `DOMAIN_NOT_VERIFIED`, `INVALID_X509_CERT`,
`INVALID_DEFAULT_ROLE`.)

---

## §2 — Where the humanizer lives

`lib/labels/org-errors.ts` carries a map from `code` → user-facing
copy. The pattern:

```ts
export const ORG_ERROR_COPY: Record<string, string> = {
  ROLE_TRANSITION_BLOCKED: "This role change is not allowed — ...",
  ORG_NOT_VERIFIED: "Your organization is awaiting verification — ...",
  // ...
};

export function humanizeOrgError(message: string): string {
  // If `message` matches a known code, return the user-facing copy;
  // else return the original message verbatim.
}
```

Every dashboard mutation site wraps `errorMessageFromBody(...)` with
`humanizeOrgError(...)` so the user sees the friendly copy. Bare
`throw new Error("ROLE_TRANSITION_BLOCKED")` from a route handler
becomes "This role change is not allowed — ..." in the UI.

Audit Phase A.2 (UI.M.4) added the humanizer wrap on `updateMember` +
`removeMember` after the test surfaced a raw `ROLE_TRANSITION_BLOCKED`
string in the Edit Member dialog.

---

## §3 — When to add a new code

Each new typed error should:

1. Have a stable `code` constant — UPPER_SNAKE_CASE, no version
   prefix. The code is the contract; the message is just copy.
2. Choose the right HTTP status:
   - `400` — request body or query was malformed (Zod failed).
   - `403` — auth gate (session valid, but lacking permission).
   - `409` — state conflict (e.g. invariant would be violated).
   - `422` — preconditions failed (the request was well-formed but
     a referenced resource isn't in the required state).
3. Throw via the `Object.assign(new Error("..."), { httpStatus, code })`
   pattern in the transaction; the route's catch block surfaces it
   in `{ error, code }` JSON.
4. Add a row to §1 of THIS doc.
5. Add a row to `lib/labels/org-errors.ts:ORG_ERROR_COPY`.
6. Add an MCP test case asserting `status` + `body.code`.

---

## §4 — Audit cross-links

- Phase A.1 (JIT role floor) — `INVALID_DEFAULT_ROLE`
- Phase A.2 (cert validation) — `INVALID_X509_CERT`
- Phase B.3 (domain ownership) — `DOMAIN_NOT_OWNED`, `DOMAIN_NOT_VERIFIED`
- Pre-audit (already shipped) — `SSO_REQUIRED`, `ROLE_TRANSITION_BLOCKED`, `LAST_OWNER_GUARD`, `ORG_NOT_VERIFIED`, `PROGRAM_TYPE_NOT_AVAILABLE`, `DOMAIN_ALREADY_REGISTERED`, `PROVIDERID_TAKEN`
