# Directus CMS — Technical Setup and Database Isolation

> How Directus CMS coexists with Prisma on the same Supabase database without conflicts.

**Status**: Design
**Decision Date**: 2026-02-02
**Related Issues**: #312 (Directus CMS Integration), #311 (Payload CMS — Rejected)

---

## Table of Contents

- [Why Directus Over Payload CMS](#why-directus-over-payload-cms)
- [Architecture Overview](#architecture-overview)
- [Database Schema Isolation](#database-schema-isolation)
- [Directus Cloud vs Self-hosted](#directus-cloud-vs-self-hosted)
- [Why Prisma Doesn't See Directus Tables](#why-prisma-doesnt-see-directus-tables)
- [Prisma DB Pull Concern](#prisma-db-pull-concern)
- [Prisma Migrate Reset — The Danger Zone](#prisma-migrate-reset--the-danger-zone)
- [Content Tables](#content-tables)
- [CMS Prefix Convention](#cms-prefix-convention)

---

## Why Directus Over Payload CMS

| CMS | Why Not Selected |
|-----|------------------|
| **Payload CMS** | Uses Drizzle ORM — conflicts with Prisma. `users` table naming collision. **REJECTED.** |
| **Strapi** | Uses Knex.js ORM — similar conflicts as Payload |
| **Outstatic** | Git-based (no DB) — limited for real-time community features |
| **KeystoneJS** | Primarily MongoDB focused, not PostgreSQL |
| **TinaCMS** | Git-based — same limitations as Outstatic |
| **Directus** | **SELECTED** — No ORM (uses DB introspection), works with existing PostgreSQL, `directus_*` prefixed tables |

Directus doesn't use an ORM at all. It introspects your database schema directly and generates APIs dynamically. This means:
- No conflict with Prisma
- Can use the same Supabase PostgreSQL database
- Only creates its own `directus_*` prefixed system tables

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    SUPABASE PROJECT                          │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              PostgreSQL Database                        │ │
│  │                                                         │ │
│  │  ┌─────────────────────┐  ┌──────────────────────────┐ │ │
│  │  │  "public" schema    │  │    "cms" schema           │ │ │
│  │  │  (Prisma)           │  │    (Directus)             │ │ │
│  │  │                     │  │                          │ │ │
│  │  │   users             │  │   cms_posts              │ │ │
│  │  │   appointments      │  │   cms_categories         │ │ │
│  │  │   payments          │  │   cms_threads            │ │ │
│  │  │   consultations     │  │   cms_replies            │ │ │
│  │  │   subscriptions     │  │   cms_community_categories│ │ │
│  │  │   ...etc            │  │   directus_users         │ │ │
│  │  │                     │  │   directus_files         │ │ │
│  │  │                     │  │   directus_permissions   │ │ │
│  │  │                     │  │   directus_settings      │ │ │
│  │  └─────────────────────┘  └──────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              Supabase Storage                           │ │
│  │   blog-images/          (featured & inline images)      │ │
│  │   community-images/     (user uploads in threads)       │ │
│  │   cms-assets/           (avatars, general assets)       │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## Database Schema Isolation

**Decision: Separate PostgreSQL schemas.**

- Prisma stays on `public` schema (default)
- Directus uses `cms` schema (configured via `DB_SCHEMA=cms` in Directus)
- `prisma migrate reset` only drops `public` — CMS data in `cms` schema survives
- Cleanest isolation, same database

This means:
- Prisma and Directus never touch each other's tables
- Development resets don't destroy CMS content
- No naming conflicts possible

---

## Directus Cloud vs Self-hosted

**Directus Cloud** is a managed SaaS where Directus hosts the admin panel and API for you. It still connects to your external Supabase PostgreSQL database.

With Directus Cloud:
- Point it at your Supabase DB connection string
- It creates `directus_*` system tables + your `cms_*` content tables directly in PostgreSQL
- Access the admin panel at `yourproject.directus.app`
- Next.js app calls the Directus Cloud API to fetch blog posts
- Eliminates deploying/maintaining a separate Directus server

---

## Why Prisma Doesn't See Directus Tables

Prisma schema is **not** a mirror of your database. It only defines models that Prisma **manages**. Your database can have tables that Prisma doesn't know about — they coexist fine. Prisma's migrations only touch tables defined in `schema.prisma`.

With the separate `cms` schema approach, this is even cleaner — Prisma only looks at the `public` schema by default.

---

## Prisma DB Pull Concern

If you run `prisma db pull` (introspection), it could potentially pull tables from other schemas depending on configuration.

**Solutions:**
1. **Never use `prisma db pull`** — stick to the `prisma migrate` workflow (which we already use). This is the recommended approach.
2. If you ever must introspect, manually remove the Directus-related models afterwards.
3. The separate PostgreSQL schema (`cms`) provides natural isolation from `prisma db pull` since it defaults to the `public` schema.

---

## Prisma Migrate Reset — The Danger Zone

| Command | Effect on Directus Tables (cms schema) |
|---|---|
| `prisma migrate deploy` | **Safe** — only applies Prisma migrations to `public` schema |
| `prisma migrate dev` | **Safe** — creates new migration for Prisma schema changes only |
| `prisma db seed` | **Safe** — only seeds Prisma-managed tables |
| `prisma migrate reset` | **Safe with separate schemas** — only drops `public` schema, `cms` schema survives |
| `prisma db push` | **Safe** — only pushes Prisma schema changes to `public` |

With separate PostgreSQL schemas, `prisma migrate reset` is safe because it only affects the `public` schema. This was a key reason for choosing the separate schema approach over keeping everything in `public`.

---

## Content Tables

All managed by Directus in the `cms` schema:

| Directus Collection (Admin UI) | Actual Table Name | Purpose |
|-------------------------------|-------------------|---------|
| Posts | `cms_posts` | Blog articles |
| Categories | `cms_categories` | Blog categories |
| Threads | `cms_threads` | Gated community threads |
| Replies | `cms_replies` | Thread replies |
| Community Categories | `cms_community_categories` | Community topic categories |

---

## CMS Prefix Convention

All Directus content tables use a `cms_` prefix to prevent any naming conflicts. When creating collections in Directus, we specify a custom table name:

```json
{
  "collection": "posts",
  "schema": {
    "name": "cms_posts"
  }
}
```

This way:
- Directus admin shows "Posts" (clean UI)
- Database table is `cms_posts` (no conflicts)
- Future Prisma tables can coexist safely
