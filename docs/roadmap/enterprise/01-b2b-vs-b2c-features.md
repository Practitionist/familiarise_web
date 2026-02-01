# Enterprise — B2B vs B2C Feature Comparison

> What enterprise customers get extra or differently compared to regular B2C customers.

**Status**: Design
**Decision Date**: 2026-02-02
**Related Issues**: #367 (Enterprise Recording Library), #338 (Feature Gap Analysis)

---

## Table of Contents

- [Feature Comparison Matrix](#feature-comparison-matrix)
- [Enterprise Pricing Tiers](#enterprise-pricing-tiers)
- [Existing GitHub Issues for Enterprise](#existing-github-issues-for-enterprise)
- [Enterprise-Specific Notifications](#enterprise-specific-notifications)
- [Enterprise-Specific Email Sequences](#enterprise-specific-email-sequences)

---

## Feature Comparison Matrix

| Feature | B2C (Individual Consultees) | B2B (Enterprise) |
|---|---|---|
| **Onboarding** | Self-signup | SSO (SAML/OIDC) via company IdP |
| **Account structure** | Individual user | Organization → Teams → Members |
| **Billing** | Per-session or subscription | Org-level invoicing, PO support, GST compliance |
| **Seat management** | N/A | Admin allocates seats, tracks usage |
| **Content access** | Book live sessions | Recording library access + live sessions |
| **Analytics** | Personal history | Team learning progress dashboard |
| **Branding** | Platform branding | Custom branding (whitelabel lite) |
| **Support** | Standard tickets | Dedicated support, SLA guarantees |
| **API access** | N/A | API keys for integrations (LMS, HRIS) |
| **Recording collections** | Per-session recordings | Curated playlists by topic/role |

---

## Enterprise Pricing Tiers

From Issue #367:

| Plan | Seats | Price/Month | Features |
|------|-------|-------------|----------|
| **Team** | 10 | ₹9,999 | Basic library access, member management |
| **Business** | 50 | ₹39,999 | + Admin dashboard, analytics, collections |
| **Enterprise** | Unlimited | Custom | + SSO, API, dedicated support, custom branding |

---

## Existing GitHub Issues for Enterprise

| Issue | Title | Status | Relevance |
|---|---|---|---|
| #367 | Enterprise Recording Library — B2B Marketplace Expansion | OPEN | Core enterprise feature proposal with schema, pricing, and implementation plan |
| #338 | Feature Gap Analysis: Familiarise vs Competitors | OPEN | Two-product strategy (Familiarise for mentors, Tiringly for courses) with gap analysis |
| #366 | Recording Monetization: Access Tiers, Replay Store & Recovery Upsell | OPEN | Recording access tiers that enable enterprise library |
| #326 | Support multiple admin levels (SUPER_ADMIN, ADMIN, MODERATOR) | OPEN | Granular admin permissions needed for enterprise org admins |
| #380 | Implement Referral System & Affiliate Program | OPEN | Enterprise referral could drive B2B leads |
| #312 | Integrate Directus CMS for Blog and Community Features | OPEN | CMS for enterprise knowledge base content |

---

## Enterprise-Specific Notifications

Via Novu (see [notification-strategy.md](../notifications/notification-strategy.md)):

- "New member joined your organization"
- "Seat usage at 90% capacity"
- "Monthly invoice ready"
- "Team member completed recording X"
- "SSO configuration updated"
- "Invitation accepted/expired"

---

## Enterprise-Specific Email Sequences

Via ConvertKit (see [03-convertkit-newsletter.md](../content-strategy/03-convertkit-newsletter.md)):

- Onboarding drip for new org admins (Day 1: Welcome + setup guide, Day 3: How to invite team members, Day 7: How to create recording collections, Day 14: Book a demo with our team)
- Monthly usage digest
- Plan upgrade nudges
