# BetterAuth vs NextAuth — Migration Decision

> Decision record for migrating from NextAuth (Auth.js) to BetterAuth for authentication and enterprise features.

**Status**: Approved — Migration planned
**Decision Date**: 2026-02-02
**Related Issues**: #367 (Enterprise Recording Library), #405 (User Lifecycle)

---

## Table of Contents

- [Context](#context)
- [Major News: Auth.js Joined BetterAuth](#major-news-authjs-joined-betterauth)
- [Feature Comparison](#feature-comparison)
- [BetterAuth Enterprise Features Detail](#betterauth-enterprise-features-detail)
- [NextAuth Enterprise Features (Limitations)](#nextauth-enterprise-features-limitations)
- [Current NextAuth Setup](#current-nextauth-setup)
- [Migration Risk Assessment](#migration-risk-assessment)
- [Migration Steps](#migration-steps)
- [Prisma Adapter](#prisma-adapter)
- [Community and Maturity Comparison](#community-and-maturity-comparison)
- [Pricing Comparison](#pricing-comparison)
- [Decision](#decision)

---

## Context

The platform currently uses NextAuth with Google, GitHub, Facebook OAuth + Credentials provider, JWT sessions. We evaluated whether BetterAuth would better serve our needs, especially for upcoming enterprise features (SSO, organizations, RBAC, team management).

---

## Major News: Auth.js Joined BetterAuth

**In September 2025, the Auth.js (NextAuth) core team officially joined BetterAuth.** Auth.js is now in maintenance mode (security patches only). Auth.js v5 never reached a stable release.

The `next-auth` npm package still has ~2 million weekly downloads due to its massive existing install base, but active feature development has moved to BetterAuth. The Auth.js team itself now recommends migrating to BetterAuth.

---

## Feature Comparison

| Aspect | NextAuth (Auth.js) | BetterAuth |
|---|---|---|
| **Status** | Maintenance mode | Active development (v1.4.15+) |
| **Enterprise SSO (SAML/OIDC)** | Not built-in (needs WorkOS/PropelAuth) | First-class `@better-auth/sso` plugin |
| **Organizations / Multi-tenant** | Not built-in | First-class plugin with teams, roles, invitations |
| **RBAC** | Manual via callbacks | Built-in with resource-action permissions |
| **API Key Management** | Not available | First-class plugin |
| **Admin Dashboard** | Not available | Community project + Admin plugin |
| **Stripe Billing Integration** | Not available | First-class `@better-auth/stripe` plugin |
| **Prisma Adapter** | Yes (`@auth/prisma-adapter`) | Yes, with CLI schema generation + join optimizations |
| **GitHub Stars** | ~28k | ~25k |
| **npm Weekly Downloads** | ~2M (legacy momentum) | ~612k (growing fast) |
| **License** | ISC (free) | MIT (free, all plugins free) |
| **Funding** | Community | $5M seed (YC, Peak XV) |

---

## BetterAuth Enterprise Features Detail

### SSO (SAML & OIDC)

**Production-ready via `@better-auth/sso` package.**

- Supports OpenID Connect (OIDC), OAuth2, and SAML 2.0
- SAML 2.0 includes InResponseTo validation for enhanced security (opt-in)
- Supports provider limits tied to billing plans (e.g., free plan = 1 SSO provider, pro = unlimited)
- Auto-provisions users and assigns them to organizations when they sign in via SSO
- Both OIDC and SAML are now declared production-ready as of v1.3

### Organization / Multi-Tenant Support

**First-class plugin.**

- Organizations with members, roles, and invitations
- Teams within organizations (hierarchical, added in v1.3)
- Members can belong to multiple teams
- Custom fields on organization, member, and invitation models via `additionalFields`
- Dynamic access control — roles and permissions stored in DB, can be changed at runtime
- A dedicated `teamMembers` table (introduced as a breaking change in v1.3)

### Role-Based Access Control (RBAC)

**Built into both the Organization and Admin plugins.**

Organization Plugin RBAC:
- Default roles: Owner, Admin, Member (customizable)
- Users can hold multiple roles (comma-separated storage)
- Permissions structured as resource-action pairs (e.g., `project: ["create", "update", "delete"]`)
- Fully extensible — define custom entities and action types
- `hasPermission()` function for checking authorization
- Dynamic access control mode stores roles/permissions in DB for runtime changes

Admin Plugin RBAC:
- Custom access controller via `createAccessControl`
- Define resources with fine-grained actions
- Create roles with specific permission sets
- Admin operations: create users, manage roles, ban/unban, impersonate, set passwords

### Team Management

- Teams are a first-class concept within organizations
- Each team has its own members, roles, and the same RBAC system applies at team level
- Members can belong to multiple teams within an organization

### API Key Management

**First-class plugin.**

- Create and manage API keys with `name`, `expiresIn`, `prefix`, and `metadata`
- Automatic cleanup of expired keys with rate-limited cooldown
- `sessionForAPIKeys` option creates mock sessions from API key headers (great for programmatic access)
- Multiple storage modes: database (default) or secondary storage (e.g., Redis)
- Pre-built UI component via Better Auth UI (`SettingsCards` with `view="API_KEYS"`)

### Admin Dashboard

- Community-built admin dashboard: `better-auth-dashboard`
- Uses a plugin-based architecture to control which components are visible
- The Admin plugin itself provides endpoints for user management, role management, banning, and impersonation

### Billing / Stripe Integration

**First-class plugin.**

- `@better-auth/stripe` handles customer creation, subscription management, and webhook processing
- Supports trial periods, upgrades, team seats, automatic tax, and billing portal
- Integrates with the Organization plugin for org-level subscriptions

---

## NextAuth Enterprise Features (Limitations)

| Feature | Auth.js Support | Notes |
|---|---|---|
| Basic OAuth/Social Login | YES (50+ providers) | Core strength |
| Email/Password | YES (Credentials provider) | Works, but often confusing to set up |
| RBAC | MANUAL IMPLEMENTATION | Must build via callbacks and middleware; role not in `req.auth.user` by default in v5 |
| Enterprise SSO (SAML/OIDC) | NO — Requires third-party | PropelAuth, WorkOS, Descope, or custom implementation needed |
| Organization/Multi-Tenancy | NO — Not built-in | Must build entirely from scratch or use another service |
| Team Management | NO | Not a concept in Auth.js |
| API Key Management | NO | Not available |
| Audit Logging | NO | Not available |
| Admin Dashboard | NO | Not available |
| Stripe/Billing | NO | Not available |
| Plugin Architecture | NO | Extensibility is via callbacks, adapters, and manual configuration |

Auth.js is fundamentally an authentication library. For authorization, multi-tenancy, and enterprise features, you must either build custom solutions or integrate third-party services (Clerk, WorkOS, PropelAuth, etc.).

---

## Current NextAuth Setup

**File:** `/app/api/auth/[...nextauth]/options.ts`

**Providers:**
1. Google (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
2. GitHub (GITHUB_ID, GITHUB_SECRET)
3. Facebook (FACEBOOK_CLIENT_ID, FACEBOOK_CLIENT_SECRET)
4. Credentials (Email + Password with bcrypt)

**Session Strategy:** JWT-based (30 days expiration)

**Key Callbacks:**
- **signIn**: Handles OAuth account linking (auto-links new providers to existing users by email)
- **jwt**: Enriches token with user data (role, profile IDs, onboarding status)
- **session**: Populates session from JWT (performance optimized — no DB query on every session check)
- **redirect**: Redirects authenticated users to `/explore/experts`

**TypeScript Extensions** (`next-auth.d.ts`):
- Extended Session: `id`, `emailVerified`, `phone`, `address`, `onboardingCompleted`, `role`, `consultantProfileId`, `consulteeProfileId`, `staffProfileId`

---

## Migration Risk Assessment

This is a **medium-complexity migration**. Key considerations:

- **Low risk** if starting fresh or early-stage
- **Medium risk** with existing NextAuth setup with custom callbacks and providers
- **The team recommends migration** since Auth.js is now in maintenance mode with BetterAuth receiving all active development

---

## Migration Steps

The official migration guide is available at `better-auth.com/docs/guides/next-auth-migration-guide`, and Auth.js itself now links to it at `authjs.dev/getting-started/migrate-to-better-auth`.

1. **Install Better Auth**: Set up `better-auth` and configure `BETTER_AUTH_SECRET` (32+ character random string)
2. **Map database schema**: You do NOT need to rename existing tables. Better Auth supports field mapping:
   - Session: `expires` → `expiresAt`, `sessionToken` → `token`
   - Account: `providerAccountId` → `accountId`, `refresh_token` → `refreshToken`
   - Add `createdAt` and `updatedAt` to account schema if missing
3. **Update route handler**: Rename `app/api/auth/[...nextauth]/route.ts` to `app/api/auth/[...all]/route.ts` and use `toNextJsHandler(auth)`
4. **Create auth client**: Replace `useSession()` from NextAuth with `createAuthClient` from `better-auth/react`
5. **Update middleware**: Adapt middleware to use BetterAuth's session validation (Node.js runtime in middleware supported from Next.js 15.2.0+)
6. **Add `nextCookies` plugin**: Must be the last plugin in the array — handles cookie setting in Server Actions

---

## Prisma Adapter

**BetterAuth: First-class support.**

```typescript
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
});
```

Key details:
- CLI auto-generates Prisma schema: `npx @better-auth/cli generate`
- Supports database joins for 2-3x performance improvements (experimental, since v1.4.0)
- Compatible with Prisma 7+ (requires explicit `output` path)
- Also supports Drizzle and MongoDB adapters
- Prisma has published official integration guides for BetterAuth

---

## Community and Maturity Comparison

| Metric | BetterAuth | Auth.js (NextAuth) |
|---|---|---|
| **GitHub Stars** | ~25,000 | ~28,000 |
| **Weekly npm Downloads** | ~612,000 | ~2,000,000 |
| **First Release** | 2024 | 2020 |
| **Discord Community** | 5,000+ members | Larger (established) |
| **Framework Endorsements** | Recommended by Next.js, Nuxt, Astro | Was the default for Next.js |
| **Active Development** | YES — active, frequent releases (v1.4.15 as of Jan 2026) | MAINTENANCE MODE — security patches only |
| **v5 Stable Release** | N/A | Never released (stuck in beta since Oct 2023) |
| **Lead Maintainer** | Active (Bereket) | Balazs Orban left in Jan 2025; team joined BetterAuth in Sep 2025 |

---

## Pricing Comparison

| Aspect | BetterAuth | Auth.js (NextAuth) |
|---|---|---|
| **License** | MIT (free, open source) | ISC (free, open source) |
| **Per-User Fees** | None | None |
| **Feature Paywalls** | None — all plugins are free | None |
| **Self-Hosting** | Fully supported | Fully supported |
| **Actual Costs** | Server + database hosting + dev time | Same + cost of third-party services for enterprise features (SSO, RBAC, etc.) |

**Key insight**: While both are free and open-source, Auth.js users often end up paying for third-party services to get enterprise features (WorkOS for SSO, Clerk for org management, etc.). BetterAuth includes these capabilities for free via plugins, making the total cost of ownership significantly lower for enterprise use cases.

---

## Decision

**Migrate to BetterAuth.** Reasons:

1. It has all the enterprise features we need built-in or via free plugins (SSO, organizations, RBAC, teams, API keys, Stripe billing)
2. Auth.js cannot match these features without significant custom development or paid third-party integrations
3. Auth.js is now in maintenance mode — the core team has joined BetterAuth
4. Prisma integration is first-class with CLI-generated schemas and join optimizations
5. No vendor lock-in — MIT licensed, self-hosted, we own our data
6. Active development with frequent releases and a well-funded team

**Implementation order**: Migrate auth first, then enable Organization plugin for enterprise features. This avoids building parallel org infrastructure.
