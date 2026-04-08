> **⚠️ SUPERSEDED on 2026-04-08.** Folded into the canonical enterprise design being written in PR2 as `/docs/enterprise/00-canonical-design.md`. Retained for historical context.

# Enterprise Features

> B2B enterprise tier for organizations — SSO, team management, recording library, org billing.

**Status**: Design
**Decision Date**: 2026-02-02
**Related Issues**: #367 (Enterprise Recording Library), #338 (Feature Gap Analysis), #326 (Multiple Admin Levels)

---

## Table of Contents

- [Overview](#overview)
- [Documents in This Section](#documents-in-this-section)
- [Key Decisions](#key-decisions)
- [Implementation Order](#implementation-order)

---

## Overview

The platform currently targets only B2C (individual consultees). Enterprise features will enable companies to provide learning resources to employees at scale, with team/organization management, SSO, and org-level billing.

The enterprise tier builds on top of BetterAuth's Organization plugin (see [betterauth-migration.md](../auth/betterauth-migration.md)) rather than creating parallel organization infrastructure.

---

## Documents in This Section

- [01-b2b-vs-b2c-features.md](./01-b2b-vs-b2c-features.md) — Feature comparison between B2C and B2B tiers
- [02-schema-changes.md](./02-schema-changes.md) — All Prisma schema changes needed for enterprise + auth migration

---

## Key Decisions

1. **Full enterprise tier** — Organization model, SSO, team management, recording library, org billing (as proposed in Issue #367)
2. **Additive schema changes only** — All new models and optional relations, no breaking migrations
3. **BetterAuth Organization plugin** — Provides the core org/member/invitation/team infrastructure; we extend with custom fields
4. **Existing B2C users unaffected** — All org relations are optional

---

## Implementation Order

1. Migrate to BetterAuth (prerequisite — provides Organization plugin)
2. Enable Organization plugin with custom fields (plan, seats, billing)
3. Add custom enterprise models (OrgInvoice, RecordingCollection, MemberProgress, etc.)
4. Build enterprise dashboard UI
5. Implement SSO via BetterAuth SSO plugin
