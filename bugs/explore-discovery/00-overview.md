# Explore & Discovery — Overview

## Context

Public discovery: `/explore/experts` (cached consultant cards, filters, infinite scroll), `/explore/programs` (classes/webinars), enterprise org browse. Community page is marketing placeholder. Trials via `TrialBookingModal`. Marketplace visibility helpers in `lib/api/plans/visibility.ts`. Verified consultants only on public explore.

## Known gaps / bugs

- Prisma `contains` search — no Algolia/Typesense; weak at scale.
- Public search OR includes consultant **email** (PII).
- Community backend missing.
- Smart matching / badges roadmap only.
- `ENABLE_HOST_ORGS` gates affiliation badges — confusing when flag off.
- Paid trial wiring partial — conversion funnel soft.

## Unhappy paths & user psychology

- User filters “top rated” — rating denormalization wrong (see feedback pack) → misranked experts.
- Search by partial email finds people — privacy incident.
- Trial books last slot race — explore UI still shows available until refetch.
- Community CTA dead-ends — SEO bounce.

## Questions (handled?)

1. **When to add search infra?**  
   - A) At N consultants / QPS threshold  
   - B) Before launch  
   - C) Stay on Prisma  

2. **Unverified consultants in org catalogs only?**  
   - A) Yes — public VERIFIED only (current leaning)  
   - B) Show with badge  
   - C) Hide entirely until verified  

3. **Community: build or remove?**  
   - A) Remove placeholder  
   - B) Ship MVP feed  
   - C) Keep SEO shell  

## High concurrency / multi-device

Read-heavy; cache OK if checkout revalidates. Multi-device browsing is fine; booking races belong to booking pack.

## Suggested directions

Strip email from public search immediately. Align rating integrity with explore sort. Decide community fate.
