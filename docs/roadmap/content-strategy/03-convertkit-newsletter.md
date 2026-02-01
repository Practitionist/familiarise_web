# ConvertKit (Kit) Newsletter Integration

> Email marketing and newsletter strategy using ConvertKit alongside Directus CMS.

**Status**: Design
**Decision Date**: 2026-02-02
**Related Issues**: #334 (ConvertKit Newsletter)

---

## Table of Contents

- [Overview](#overview)
- [How It Connects to the Platform](#how-it-connects-to-the-platform)
- [Prisma Schema Impact](#prisma-schema-impact)
- [Integration Flow](#integration-flow)
- [Subscriber Segmentation](#subscriber-segmentation)
- [Email Sequences](#email-sequences)
- [Distinction from Resend and Novu](#distinction-from-resend-and-novu)

---

## Overview

ConvertKit (now branded as Kit) is an external email marketing service. It handles:

- Newsletter broadcasts (new blog post notifications)
- Subscriber management and segmentation
- Drip email sequences (onboarding, nurture)
- Tag-based subscriber targeting

ConvertKit uses its **own email infrastructure** — it does NOT go through Resend. It is completely independent from the Novu → Resend notification pipeline.

---

## How It Connects to the Platform

```
User subscribes on your site
  → Email saved to Newsletter model (Prisma, public schema)
  → API call to ConvertKit to add subscriber
  → ConvertKit manages from here (broadcasts, sequences, etc.)

Directus publishes a new blog post
  → Directus webhook fires
  → Hits /api/webhooks/directus
  → API route calls ConvertKit "Create Broadcast" API
  → ConvertKit sends newsletter to all subscribers
```

---

## Prisma Schema Impact

**Zero.** The existing `Newsletter` model is sufficient:

```prisma
model Newsletter {
  id        String   @id @default(cuid())
  email     String   @unique
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

This model captures subscriber emails. The actual email delivery, segmentation, and sequence management happens entirely in ConvertKit via their API. No new models, no modifications needed.

---

## Integration Flow

### New Subscriber

1. User enters email on the site (footer signup, blog sidebar, etc.)
2. Next.js API creates `Newsletter` record in Prisma
3. Same API route calls ConvertKit API to add subscriber with tags
4. ConvertKit handles welcome sequence, double opt-in, etc.

### New Blog Post Published

1. Content team publishes post in Directus admin panel
2. Directus fires webhook to `/api/webhooks/directus`
3. API route detects `items.create` event for `cms_posts`
4. Calls ConvertKit "Create Broadcast" API with post title, excerpt, link
5. ConvertKit sends to all subscribers (or filtered by tags/segments)

### Enterprise Onboarding

1. Enterprise org admin signs up
2. Your API tags them in ConvertKit as `enterprise`, `plan:business`
3. ConvertKit triggers enterprise onboarding drip sequence

---

## Subscriber Segmentation

ConvertKit tags subscribers for targeted content:

| Tag | Applied When | Used For |
|---|---|---|
| `subscriber` | Any newsletter signup | All broadcasts |
| `tech` | Selected interest on signup | Tech-related blog posts |
| `career` | Selected interest on signup | Career-related content |
| `business` | Selected interest on signup | Business strategy content |
| `enterprise` | Org admin signs up | Enterprise-specific sequences |
| `plan:team` | Enterprise team plan | Plan-specific messaging |
| `plan:business` | Enterprise business plan | Plan-specific messaging |
| `plan:enterprise` | Enterprise custom plan | Plan-specific messaging |
| `consultant` | Consultant signs up | Consultant-focused content |
| `consultee` | Consultee signs up | Consultee-focused content |

---

## Email Sequences

### B2C Welcome Sequence

- Day 0: Welcome + how the platform works
- Day 2: Featured consultants this week
- Day 5: Success story / case study
- Day 10: First booking discount

### Enterprise Onboarding Sequence

- Day 1: Welcome + setup guide
- Day 3: How to invite team members
- Day 7: How to create recording collections
- Day 14: Book a demo with our team

### Monthly Digest (Enterprise)

- Compiled by cron job → sent to ConvertKit as custom event
- ConvertKit sends branded monthly report with org analytics

---

## Distinction from Resend and Novu

| Service | Purpose | Sends Through |
|---|---|---|
| **ConvertKit** | Email MARKETING — newsletters, drip sequences, broadcasts | Its OWN infrastructure |
| **Resend** | TRANSACTIONAL email delivery — auth emails, booking confirmations | Directly (for auth) or via Novu |
| **Novu** | Notification ORCHESTRATION — decides what/who/where/when | Routes email through Resend |

ConvertKit and Resend/Novu are completely independent pipelines. ConvertKit handles marketing emails (opt-in, unsubscribe managed by ConvertKit). Resend handles transactional emails (triggered by user actions, managed by your app).
