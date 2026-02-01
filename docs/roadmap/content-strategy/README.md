# Content Strategy

> Blog, community, newsletter, and CMS decisions for the consulting platform.

**Status**: Design
**Decision Date**: 2026-02-02
**Related Issues**: #312 (Directus CMS), #311 (Payload CMS — Rejected), #334 (ConvertKit Newsletter)

---

## Table of Contents

- [Overview](#overview)
- [Documents in This Section](#documents-in-this-section)
- [Key Decisions](#key-decisions)
- [Prisma Schema Impact](#prisma-schema-impact)

---

## Overview

We evaluated what content features a B2B2C consulting/mentorship platform should have, based on research of MentorCruise, GrowthMentor, Topmate, Preplaced, and Clarity.fm. The key findings drove our content strategy decisions.

---

## Documents in This Section

- [01-directus-cms-setup.md](./01-directus-cms-setup.md) — Directus technical setup, database isolation, lifecycle concerns
- [02-blog-and-community.md](./02-blog-and-community.md) — Research findings on blog vs community for consulting platforms
- [03-convertkit-newsletter.md](./03-convertkit-newsletter.md) — ConvertKit integration for newsletter and email sequences

---

## Key Decisions

1. **Blog via Directus CMS** — SEO-optimized, conversion-focused blog (not a generic news blog)
2. **Gated community** — Threads/replies only for authenticated paying users (retention tool, not acquisition)
3. **ConvertKit for newsletter** — Newsletter broadcasts on new blog posts, subscriber segmentation, drip sequences
4. **Separate PostgreSQL schemas** — Prisma on `public` schema, Directus on `cms` schema for clean isolation
5. **Skip public community forum** — No successful consulting platform has a public community driving meaningful signups

---

## Prisma Schema Impact

**Zero.** Directus manages its own tables in the `cms` schema. ConvertKit is an external API using the existing `Newsletter` model. No Prisma models need to be added, modified, or removed.
