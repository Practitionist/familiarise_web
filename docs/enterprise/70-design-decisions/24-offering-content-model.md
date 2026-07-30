---
title: An offering is described by structured content, not one free-text blob
band: 70-design-decisions
audience: sde2
status: live
last-reviewed: 2026-07-31
---

# ADR 24 — The offering content model

## Context

The platform sells four things: a one-off consultation, a recurring subscription, a single-sitting webinar, and a multi-week class. Competitors selling the same multi-month mentorship — Preplaced and Propeers are the two we were measured against — describe it in structured pieces: a week-by-week roadmap with a title and a description per week, an explicit statement of who the programme is for, a list of what the price actually buys, and an FAQ that answers the questions that otherwise stall a purchase. Our plans carried a title, a long description, a flat array of learning outcomes, and a pair of free-text prerequisite and materials fields.

A review of the four models found that the roadmap was already half-built and largely invisible. `ClassContent` and `SubscriptionContent` had existed for some time, each carrying a title, a description, an ordinal, an hours allocation and an optional content type and URL. Both were authored in the planner, under the headings "Class Curriculum" and "Session Roadmap". `ClassContent` was rendered on the class detail page, and `SubscriptionContent` was rendered in the subscription pricing toggle as a week-by-week timeline. What was missing was not the table but three things around it: a label for each week, so a consultant could say "Week 1" or "Sprint 2" or group two sessions under one heading; any of the surrounding positioning content; and parity, because the two one-off types had no structured content at all and the two 1:1 types had neither a cover image nor an archive column.

Two further findings shaped the decision. The first is that a large part of the perceived thinness was a seed problem rather than a product problem. Every topic name was `faker.lorem.words(3)`, webinar and class descriptions were lorem paragraphs, every class curriculum module was lorem, and `subscriptionContents` was never seeded at all — so the week-by-week outline the profile page already rendered was permanently empty in every local database. The second is that `level` was a free-text `String` on all four models with no validation, so "Beginner", "Begineer" and "Anyone" could all coexist and the explore level facet could never reliably match.

## Decision

**An offering is described by structured, separately-addressable content, and every plan type carries the same shape.**

Four fields land on all four plan models. `subtitle` is the one-line pitch that appears on cards and in search results, distinct from `description`, which is long-form and reads badly when clamped. `targetAudience` and `whatsIncluded` are string arrays holding the "who this is for" and "what the price buys" bullets. `slug` is reserved for SEO-friendly URLs and is nullable, because the routing that would use it is deliberately not part of this change.

A new `PlanFaq` model holds the question-and-answer pairs. It is polymorphic across the four plan types, using the same four-nullable-foreign-keys shape that `PlanMaterial` has used for attachments since before this change, because an FAQ is the same kind of thing as an attachment: an ordered child list that belongs to exactly one plan of an unknown type.

**The two curriculum tables stay separate.** Collapsing `ClassContent` and `SubscriptionContent` into one polymorphic model was considered and rejected. The two are near-identical today, and a polymorphic table would have removed a duplicated shape and incidentally allowed a webinar to carry an agenda. Against that, they describe genuinely different things — a class module is a unit of syllabus delivered to a cohort, a subscription session is one appointment in a 1:1 engagement — and they are free to diverge as the two products do. Both gain the same two new columns, `sectionLabel` and `outcomes`, and the authoring payload for both is one shared type, so the duplication is confined to the table definitions rather than spreading through the code that reads and writes them.

**`sectionLabel` is free text, not a week number.** An integer would have been tighter, and it was rejected because consultants do not consistently think in weeks: the same field has to hold "Week 1", "Week 1-2", "Module 3", "Sprint 1" and "Phase 2". Ordering still comes from `order`; the label is presentation. Items that share a label render under one heading, which is what allows two sessions to sit inside one week. Grouping only merges *adjacent* items, so a label repeated later in the list starts a new group rather than pulling a later session backwards and silently reordering the roadmap.

**`level` becomes the `PlanLevel` enum** — `BEGINNER`, `INTERMEDIATE`, `ADVANCED`, `ALL_LEVELS` — and every surface that displays it reads its copy from `lib/labels/plan-labels.ts` rather than printing the enum member. The facet on `/explore/programs` still reads the distinct values from the database rather than listing the enum, so it only offers levels some plan actually has, and it sorts them in teaching order because alphabetical sorting renders Advanced, All levels, Beginner, Intermediate.

**Subscription detail is a modal, not a route.** A subscription is the highest-consideration product on the platform, and the sidebar pricing toggle it is reached from is roughly 450 pixels wide, which cannot show a twelve-session roadmap legibly. A dedicated route was rejected as the wrong weight for a surface reached from one place, and a standalone consultation page was rejected outright: a single call is decided in seconds, and a page carrying four bullets is a thin page that costs more in SEO than it earns. Consultations therefore expand in place, and the subscription roadmap modal grows the positioning and FAQ sections beneath the timeline it already showed.

## Consequences

The schema freeze holds: every column the content model needs is present, including the ones whose user interface is deferred. `slug` exists with no routing behind it, and that is deliberate — adding the column later would have reopened the freeze.

`callsPerWeek` and `meetingsPerWeek` are unified as `sessionsPerWeek`, closing the naming decision that issue #1011 flagged as blocking the freeze. The allocation engine already used one internal name for both, so the rename removed a translation layer rather than adding one.

`marketplaceVisibilityWhere()` and `eventPlanDiscoverableWhere()` no longer differ by plan type. The narrower helper existed only because `ConsultationPlan` and `SubscriptionPlan` had no `archivedAt` column for Prisma to filter on; both now do, so the discoverable filter is correct for all four and is the one public surfaces should use.

`OrgPlanVisibility.ORG_ONLY` is no longer write-only. It was possible to author a plan, narrow it to members, and have it become invisible to everyone including the members it was authored for, because the marketplace filter correctly hid it from `/explore/**` and no other surface ever showed it. The member-facing catalog panel on `my-program` is that surface. Per [ADR 19](19-personal-vs-org-dashboard-split.md) it is a panel on an existing destination rather than a new navigation entry, because it is a scope variant of something the learner already has rather than a distinct place to go.

The seed suite now produces real copy for every plan type, seeds the subscription roadmap that was previously always empty, and creates org-owned plans across all three visibility values plus one archived plan — so the catalog, archive and leak-guard paths shipped by #1050 and #1053 have rows to exercise for the first time.
