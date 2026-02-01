# Service Integration Architecture

> How Directus CMS, ConvertKit, Resend, Novu, and Enterprise features are interlinked.

**Status**: Design
**Decision Date**: 2026-02-02
**Related Issues**: #312 (Directus CMS), #334 (ConvertKit Newsletter), #300 (In-App Notifications), #399 (Novu Webhooks), #367 (Enterprise)

---

## Table of Contents

- [Overview](#overview)
- [User Layer](#user-layer)
- [Application Layer](#application-layer)
- [Database Architecture](#database-architecture)
- [Service Interlinking Diagram](#service-interlinking-diagram)
- [Flow Explanations](#flow-explanations)
- [Service Responsibility Matrix](#service-responsibility-matrix)

---

## Overview

The platform uses five external services that interlink with each other and the core application:

| Service | Role | Analogy |
|---|---|---|
| **Directus CMS** | Content management (blog, community) | The editor |
| **ConvertKit (Kit)** | Email marketing & newsletters | The marketer |
| **Resend** | Transactional email delivery | The postman |
| **Novu** | Notification orchestration | The brain |
| **Enterprise** | B2B org management (BetterAuth plugins + custom) | The business tier |

---

## User Layer

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    YOUR USERS                                                │
│                                                                                              │
│   B2C Consultees    B2C Consultants    Enterprise Admins    Enterprise Members    Staff/Admin │
└──────┬──────────────────┬───────────────────┬──────────────────────┬──────────────┬──────────┘
       │                  │                   │                      │              │
       ▼                  ▼                   ▼                      ▼              ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                                NEXT.JS APPLICATION                                           │
│                                                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  ┌───────────────────┐ │
│  │ Public Site  │  │ Consultee    │  │ Consultant   │  │ Enterprise │  │ Staff/Admin       │ │
│  │             │  │ Dashboard    │  │ Dashboard    │  │ Dashboard  │  │ Dashboard         │ │
│  │ • Blog      │  │ • Bookings   │  │ • Earnings   │  │ • Members  │  │ • Moderation      │ │
│  │ • Mega Nav  │  │ • Community  │  │ • Schedule   │  │ • Seats    │  │ • Verification    │ │
│  │ • Pricing   │  │   (gated)    │  │ • Reviews    │  │ • Analytics│  │ • Support tickets │ │
│  │ • Use Cases │  │ • Sessions   │  │ • Payouts    │  │ • Billing  │  │ • System jobs     │ │
│  └──────┬──────┘  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘  └────────┬──────────┘ │
│         │                │                  │                │                   │            │
│  ┌──────┴────────────────┴──────────────────┴────────────────┴───────────────────┴─────────┐  │
│  │                           INTERNAL SERVICE LAYER                                        │  │
│  │                                                                                         │  │
│  │  BetterAuth ──── Session/JWT/OAuth/SSO ──── Organization Plugin ──── RBAC               │  │
│  │  Prisma ORM ──── public schema queries                                                  │  │
│  │  Directus SDK ── cms schema queries (blog + community)                                  │  │
│  │  Stream SDK ──── Video calls + Chat + Recordings                                        │  │
│  │  Stripe/Razorpay ── Payments + Payouts                                                  │  │
│  └──────┬────────────────┬──────────────────┬────────────────┬───────────────────┬─────────┘  │
└─────────┼────────────────┼──────────────────┼────────────────┼───────────────────┼────────────┘
          │                │                  │                │                   │
          ▼                ▼                  ▼                ▼                   ▼
```

---

## Application Layer

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                              SUPABASE (Database + Storage)                                    │
│                                                                                              │
│  ┌──────────────────────────────┐    ┌────────────────────────────────────────────────┐      │
│  │    "public" schema (Prisma)  │    │         "cms" schema (Directus)                │      │
│  │                              │    │                                                │      │
│  │  User, Account, Session      │    │  cms_posts          (blog articles)            │      │
│  │  ConsultantProfile           │    │  cms_categories      (blog categories)          │      │
│  │  ConsulteeProfile            │    │  cms_threads         (gated community)          │      │
│  │  Organization ←── NEW        │    │  cms_replies         (gated community)          │      │
│  │  OrgMember    ←── NEW        │    │  cms_community_categories                      │      │
│  │  Consultation, Subscription  │    │  directus_users      (CMS admin accounts)       │      │
│  │  Payment, Payout, Invoice    │    │  directus_files      (media uploads)            │      │
│  │  Recording                   │    │  directus_permissions                           │      │
│  │  Newsletter ──────────────── │ ── │ ─── (subscriber emails synced to ConvertKit)    │      │
│  │  ...51 models total          │    │                                                │      │
│  └──────────────────────────────┘    └────────────────────────────────────────────────┘      │
│                                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐    │
│  │  Supabase Storage                                                                    │    │
│  │  • profile-images/    • appointment-documents/    • blog-images/ (via Directus)      │    │
│  │  • recordings/        • verification-docs/        • community-images/ (via Directus) │    │
│  └──────────────────────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Database Schema Isolation Decision

**Decision**: Separate PostgreSQL schemas.

- Prisma stays on `public` schema
- Directus uses `cms` schema
- `prisma migrate reset` only drops `public` — CMS data in `cms` schema survives

See [01-directus-cms-setup.md](../content-strategy/01-directus-cms-setup.md) for detailed technical analysis.

---

## Service Interlinking Diagram

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                          HOW THE 5 SERVICES INTERLINK                                        │
│                                                                                              │
│                                                                                              │
│   ┌─────────────────────┐         ┌──────────────────────┐         ┌─────────────────────┐   │
│   │    DIRECTUS CMS     │         │    CONVERTKIT (Kit)  │         │      RESEND          │   │
│   │    (Content)        │         │    (Email Marketing) │         │  (Transactional      │   │
│   │                     │         │                      │         │       Email)         │   │
│   │ • Blog posts        │────①───▶│ • Newsletter blasts  │         │                     │   │
│   │ • Blog categories   │         │ • Subscriber mgmt   │         │ • Welcome email     │   │
│   │ • Community threads │         │ • Email sequences    │         │ • Password reset    │   │
│   │ • Community replies │         │ • Tags & segments    │         │ • Booking confirm   │   │
│   │                     │         │                      │         │ • Payment receipt   │   │
│   │ Hosted: Directus    │         │ Hosted: Kit Cloud    │         │ • Payout notify     │   │
│   │  Cloud              │         │                      │         │ • OAuth link notify │   │
│   └──────────┬──────────┘         └───────────┬──────────┘         └──────────┬──────────┘   │
│              │                                │                               │              │
│              │ ②                              │ ⑤                             │ ④            │
│              │                                │                               │              │
│              ▼                                ▼                               │              │
│   ┌──────────────────────────────────────────────────────────────────────────┐│              │
│   │                        NOVU                                              ││              │
│   │                  (Notification Orchestrator)                             ││              │
│   │                                                                          ││              │
│   │  Novu is the BRAIN that decides:                                        ││              │
│   │    • WHAT to send (template)                                            ││              │
│   │    • WHO to send to (subscriber)                                        ││              │
│   │    • WHERE to send (channel: email, push, in-app, SMS)                  ││              │
│   │    • WHEN to send (digest, delay, throttle)                             ││              │
│   │                                                                          ││              │
│   │  Channels:                                                               ││              │
│   │    Email ─────────▶ Routes through RESEND as provider ───────────────────┘│              │
│   │    In-App ────────▶ Bell icon notifications in dashboard                  │              │
│   │    Push ──────────▶ Mobile push (familiarise_mobile)                     │              │
│   │    SMS ───────────▶ Twilio/MSG91 (future)                                │              │
│   └──────────────────────────────────────────────────────────────────────────┘               │
│              ▲                                                                                │
│              │ ③                                                                              │
│              │                                                                                │
│   ┌──────────┴───────────────────────────────────────────────────────────────────────────┐   │
│   │                           ENTERPRISE FEATURES                                         │   │
│   │                      (BetterAuth Org Plugin + Custom)                                 │   │
│   │                                                                                       │   │
│   │  Organization ──▶ SSO login (SAML/OIDC) ──▶ BetterAuth                               │   │
│   │  OrgMember    ──▶ Team management, seat allocation                                    │   │
│   │  OrgInvoice   ──▶ Org billing (Stripe) ──▶ Invoice PDF via RESEND ──④                │   │
│   │  RecordingCollection ──▶ Curated libraries from existing Recordings                   │   │
│   │  MemberProgress ──▶ Tracks what team members watched/completed                        │   │
│   │                                                                                       │   │
│   │  Enterprise-specific notifications via NOVU: ──③                                      │   │
│   │    • "New member joined your organization"                                            │   │
│   │    • "Seat usage at 90% capacity"                                                     │   │
│   │    • "Monthly invoice ready"                                                          │   │
│   │    • "Team member completed recording X"                                              │   │
│   │                                                                                       │   │
│   │  Enterprise-specific email sequences via CONVERTKIT: ──⑤                              │   │
│   │    • Onboarding drip for new org admins                                               │   │
│   │    • Monthly usage digest                                                             │   │
│   │    • Plan upgrade nudges                                                              │   │
│   └──────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                              │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Flow Explanations

### Flow ① — DIRECTUS → CONVERTKIT (New blog post → Newsletter)

```
Directus publishes a blog post
  → Directus webhook fires on "items.create" for cms_posts
  → Webhook hits your Next.js API route /api/webhooks/directus
  → API route calls ConvertKit "Create Broadcast" API
  → ConvertKit sends newsletter to all subscribers
  → Subscribers tagged by interest (e.g., "tech", "career")
```

### Flow ② — DIRECTUS → NOVU (Community activity → Notifications)

```
Someone replies to a gated community thread
  → Directus webhook fires on "items.create" for cms_replies
  → Webhook hits /api/webhooks/directus
  → Triggers Novu workflow "community-reply"
  → Novu sends: in-app bell notification + optional email via Resend
  → Only to the thread author (gated, paying users only)
```

### Flow ③ — ENTERPRISE → NOVU (Org events → Multi-channel notifications)

```
Enterprise admin invites a team member
  → BetterAuth creates invitation record
  → Your API triggers Novu workflow "org-member-invited"
  → Novu sends: email (via Resend) to invitee + in-app to org admin

Team member completes a recording
  → MemberProgress updated in DB
  → Triggers Novu workflow "recording-completed"
  → Novu sends: in-app notification to org manager
```

### Flow ④ — NOVU → RESEND (Novu routes emails through Resend)

```
Novu is the orchestrator, Resend is the email DELIVERY provider.

ANY notification that needs email delivery:
  → Novu selects email channel
  → Novu calls Resend API to actually send the email
  → Resend handles: DKIM, SPF, deliverability, bounce handling
  → Resend webhook → Novu (delivery status tracking, Issue #399)

Some emails bypass Novu and go directly through Resend:
  → BetterAuth auth emails (verification, password reset, magic link)
  → These are simple transactional emails that don't need orchestration
```

### Flow ⑤ — ENTERPRISE → CONVERTKIT (Org-specific email marketing)

```
Enterprise org signs up
  → Org admin tagged in ConvertKit as "enterprise", "plan:business"
  → ConvertKit triggers enterprise onboarding email sequence
    (Day 1: Welcome + setup guide
     Day 3: How to invite team members
     Day 7: How to create recording collections
     Day 14: Book a demo with our team)

Monthly usage digest
  → Cron job compiles org analytics
  → Sends to ConvertKit as custom event
  → ConvertKit sends branded monthly report email
```

---

## Service Responsibility Matrix

```
┌────────────────────────┬──────────────────────────────────────────────┐
│  SERVICE               │  WHAT IT HANDLES                             │
├────────────────────────┼──────────────────────────────────────────────┤
│                        │                                              │
│  RESEND                │  Email DELIVERY (the postman)                │
│  (Transactional Email) │                                              │
│                        │  • The actual sending infrastructure         │
│                        │  • DKIM/SPF/DMARC compliance                │
│                        │  • Deliverability & bounce handling          │
│                        │  • Used BY Novu as email provider            │
│                        │  • Used directly for auth emails only        │
│                        │                                              │
├────────────────────────┼──────────────────────────────────────────────┤
│                        │                                              │
│  NOVU                  │  Notification ORCHESTRATION (the brain)      │
│  (Orchestrator)        │                                              │
│                        │  • Decides which CHANNEL (email/push/in-app) │
│                        │  • Multi-channel: same event → email + push  │
│                        │  • Digest: batches 10 events into 1 email   │
│                        │  • Subscriber preferences (quiet hours)      │
│                        │  • Routes email delivery → Resend            │
│                        │  • Handles: booking, payment, support,       │
│                        │    enterprise, community notifications       │
│                        │                                              │
├────────────────────────┼──────────────────────────────────────────────┤
│                        │                                              │
│  CONVERTKIT            │  Email MARKETING (the marketer)              │
│  (Email Marketing)     │                                              │
│                        │  • Newsletter broadcasts (new blog post)     │
│                        │  • Drip sequences (onboarding, nurture)      │
│                        │  • Subscriber segmentation & tagging         │
│                        │  • Enterprise onboarding sequences           │
│                        │  • Uses its OWN email infrastructure         │
│                        │    (does NOT go through Resend)              │
│                        │                                              │
├────────────────────────┼──────────────────────────────────────────────┤
│                        │                                              │
│  DIRECTUS              │  Content MANAGEMENT (the editor)             │
│  (CMS)                 │                                              │
│                        │  • Blog writing & publishing                 │
│                        │  • Community content moderation              │
│                        │  • Triggers webhooks on publish              │
│                        │  • Does NOT send emails itself               │
│                        │  • Webhook → your API → ConvertKit/Novu      │
│                        │                                              │
└────────────────────────┴──────────────────────────────────────────────┘
```

### Key Insight

Directus and Enterprise are **event producers**. They create content and trigger actions. Novu and ConvertKit are **event consumers** — they react to those events and deliver notifications/emails. Resend is the **infrastructure layer** that Novu uses to actually deliver emails.
