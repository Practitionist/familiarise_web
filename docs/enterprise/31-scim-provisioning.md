# SCIM 2.0 provisioning

Familiarise speaks SCIM 2.0 at `/scim/v2/**` so IdPs (Okta, Azure AD,
OneLogin, etc.) can manage organization membership without a custom
integration. The endpoints follow RFC 7643 (schema) and RFC 7644
(protocol) closely enough that the off-the-shelf SCIM connectors
work without modification.

## Endpoint inventory

| Verb | Path | Purpose |
|---|---|---|
| `GET` | `/scim/v2/Users` | List + filter (`?filter=userName eq "x"`). |
| `POST` | `/scim/v2/Users` | Create or re-provision a user. |
| `GET` | `/scim/v2/Users/[id]` | Detail. |
| `PATCH` | `/scim/v2/Users/[id]` | Currently supports `replace active` (Okta deactivate). |
| `DELETE` | `/scim/v2/Users/[id]` | Soft-deprovision (Membership.status = SUSPENDED). |

Discovery endpoints (`ServiceProviderConfig`, `ResourceTypes`,
`Schemas`) are intentionally **not** mounted in v1 — the connectors we
target hard-code the resource shape and the SCIM-compliance reports
don't depend on these. They will be added in a follow-up if a target
IdP starts requiring them.

## Authentication

Every SCIM call carries `Authorization: Bearer <raw token>`.
`/api/organizations/[orgId]/scim/tokens` (OWNER-only) mints tokens —
the **raw value is returned exactly once** on POST. We store only its
SHA-256 hash, so a lost token requires creating a fresh one. The
auth helper at `lib/scim/auth.ts` also:

- enforces `scimLimiter` (60 RPM per token);
- writes a `SCIM_TOKEN_USED_AFTER_REVOKE` audit row when a revoked
  token attempts to authenticate;
- bumps `lastUsedAt` on every successful call (fire-and-forget).

## Group → role mapping

`/api/organizations/[orgId]/scim/group-mappings` lets the OWNER bind
IdP group names to local `MemberRole` values:

| SCIM group name | → MemberRole |
|---|---|
| `IT-Admins` | `MAINTAINER` |
| `Finance-Leads` | `BILLING_ADMIN` |
| `Engineering-Managers` | `MANAGER` |
| `All-Employees` | `LEARNER` |

When a SCIM user is in multiple mapped groups, the highest-rank role
wins (see `resolveRoleFromGroupNames` in `lib/scim/resource-user.ts`).
When no group matches, the user is created as `LEARNER` — least
privilege by default.

## Erasure short-circuit

If a user has previously exercised DPDP §12 right-to-erasure
(`User.erasedAt IS NOT NULL`), every SCIM operation that would create
or re-provision them returns:

```json
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"],
  "status": "410",
  "detail": "User has been erased per DPDP §12 and cannot be re-provisioned. Remove the user from your IdP roster."
}
```

The IdP's provisioning report surfaces this as a permanent error so
the operator knows to delete the user from their IdP rather than retry
indefinitely.

## Webhooks

Every SCIM mutation that creates or removes a membership also emits
the matching outbound webhook event (`member.added` / `member.removed`),
so subscribers don't need to differentiate between in-app and
IdP-driven provisioning.

## Local integration testing

```bash
# 1. Mint a SCIM token (as OWNER).
TOKEN_PAYLOAD=$(curl -s -X POST $BASE/api/organizations/$ORG/scim/tokens \
  -H "Cookie: $OWNER_COOKIE" -H "Content-Type: application/json" \
  -d '{"label":"okta-test"}')
echo "$TOKEN_PAYLOAD" | jq .

# 2. Pull the raw token (only visible on this POST).
SCIM_TOKEN=$(echo "$TOKEN_PAYLOAD" | jq -r .token.rawToken)

# 3. Create a SCIM user.
curl -X POST $BASE/scim/v2/Users \
  -H "Authorization: Bearer $SCIM_TOKEN" \
  -H "Content-Type: application/scim+json" \
  -d '{
    "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
    "userName": "alice@acme.com",
    "name": { "givenName": "Alice", "familyName": "Doe" },
    "active": true,
    "emails": [{ "value": "alice@acme.com", "primary": true }],
    "externalId": "okta-user-42",
    "groups": [{ "value": "IT-Admins" }]
  }'

# 4. Deactivate.
curl -X PATCH $BASE/scim/v2/Users/okta-user-42 \
  -H "Authorization: Bearer $SCIM_TOKEN" \
  -H "Content-Type: application/scim+json" \
  -d '{
    "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    "Operations": [{ "op": "replace", "path": "active", "value": false }]
  }'
```

## Audit trail

All SCIM mutations land in `OrgAuditLog` under the `SYSTEM` category:

- `SCIM_USER_CREATED` / `SCIM_USER_UPDATED` / `SCIM_USER_DEPROVISIONED`
- `SCIM_GROUP_MAPPED` / `SCIM_GROUP_UNMAPPED`
- `SCIM_TOKEN_CREATED` / `SCIM_TOKEN_REVOKED` / `SCIM_TOKEN_USED_AFTER_REVOKE`
