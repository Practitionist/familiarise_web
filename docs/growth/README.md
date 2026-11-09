---
title: Growth — Index
type: reference
status: live
last-reviewed: 2026-11-08
---

# Growth

Growth is the set of features that bring people to Familiarise and bring them back: the newsletter and announcements, the appointment waitlist and slot backup interest, and referrals. This folder is the subsystem documentation. The agent playbook is the [growth skill](../../.claude/skills/growth/SKILL.md), and the owner's decisions are in [the growth decision record](../decisions/2026-11-08-growth-waitlist-newsletter-referrals.md), which lands with #2655 "Growth: rename the newsletter list, derive link keys, one consent ledger, segmented broadcasts".

## Which pull request carries which code

The code these pages describe is in three pull requests that merge before this one. Each page marks behaviour that is not on `dev` yet with the tag of the pull request that brings it.

| Tag     | Pull request                                                                                                | What it carries                                                                       |
| ------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `#2655` | #2655 "Growth: rename the newsletter list, derive link keys, one consent ledger, segmented broadcasts"      | The newsletter rename, link signing, the consent ledger and segmented broadcasts.     |
| `#2656` | #2656 "Growth: appointment waitlist capacity fix, host demand counts, shared interest lifecycle, My alerts" | Capacity normalisation, host counts, the shared interest module, My alerts, `demand`. |
| `#2657` | #2657 "Growth: referral fraud controls, review hold, shared-payer and chargeback voids"                     | Referral fraud controls, the review hold and the chargeback void.                     |

## The pages

| #   | Page                                                                                              | Type        | Read it to learn                                                                                          |
| --- | ------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------- |
| 00  | [Overview and high-level design](./00-overview.md)                                                | explanation | What growth is as one subsystem, what its three parts share, the vocabulary and where the code lives.     |
| 01  | [Appointment waitlist and slot backup interest](./01-appointment-waitlist-and-backup-interest.md) | explanation | Why every waiter is told at once, the lifecycle, the release paths, the caps and a worked example.        |
| 02  | [Newsletter and announcements](./02-newsletter-and-announcements.md)                              | explanation | Double opt-in, the consent ledger, link signing, broadcast modes, unsubscribe and the sending subdomains. |
| 03  | [Referrals](./03-referrals.md)                                                                    | explanation | The three programmes, the launch scope, the fraud controls, the review hold and the chargeback void.      |
| 04  | [Market research, India first](./04-market-research-india-first.md)                               | reference   | The cited findings that shaped the design, and what is unverified.                                        |
| 05  | [Roadmap](./05-roadmap.md)                                                                        | reference   | Every shipped, owner-step, post-launch and handed-off item with its priority and "done when".             |

## What is not in this repository

The repository holds mechanisms, invariants, configuration field names and the terms a user sees on screen. The owner's Notion workspace ("Familiarise / Growth & Marketing") holds the referral budget, the fraud and hold thresholds, vendor costs and plan choices, growth targets, detailed competitor research and conversion read-outs. A page that needs one of those values says the value is set by the owner and kept in Notion.

## Related documents

- [Referrals in depth](../referrals/00-overview.md) and the [referral credits ledger](../finance/20-ledger/07-referral-credits.md).
- [Email delivery](../email/README.md) and [notifications](../notifications/README.md).
- [Booking](../booking/README.md) and the [seat waitlist decision](../decisions/2026-11-07-event-seat-waitlist.md).
- [DPDP and privacy](../compliance/02-dpdp-and-privacy.md).

## Deprecated & Superseded Approaches

- **One folder per feature.** Before this folder, the newsletter lived inside `docs/email/`, the waitlist inside `docs/booking/` and referrals inside `docs/referrals/`, and the row "Marketing, waitlist and announcements" in the root README read "No doc yet". Those domain pages stay as the detailed reference; this folder is the layer above them. Do not copy their tables here.
- **The word "waitlist" for the newsletter.** See [the vocabulary table](./00-overview.md#the-vocabulary).
