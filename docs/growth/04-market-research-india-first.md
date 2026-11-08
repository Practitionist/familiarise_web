---
title: Growth — Market Research, India First
type: reference
status: live
last-reviewed: 2026-11-08
---

# Market Research, India First

This page lists the findings that shaped the growth design, each with its source. Indian sources come first and a US source appears only as a labelled fallback. The detailed competitor research, with names, prices and conversion figures, is kept in Notion (Familiarise / Growth & Marketing), not here. Anything not confirmed from a source is in [the Unverified list](#unverified). Facts were checked against the cited pages in November 2026; vendor pricing changes, so re-check before relying on a number.

## Sold-out queues

| Finding                                                                                                                                          | Source                                                                                                                                                                    | Effect on the design                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| No Indian platform (BookMyShow, Townscript, Insider/District, Konfhub, Topmate) publishes its waitlist mechanics.                                | Searched for each platform's help pages; none described the mechanics.                                                                                                    | There is no Indian standard to match, so the simplest safe model was chosen.                 |
| One BookMyShow event reported 42,000+ people on its waitlist.                                                                                    | [India TV News](https://www.indiatvnews.com/news/india/pm-modi-s-first-programme-on-bookmyshow-sold-out-in-an-hour-over-42000-on-waitlist-in-vadodara-2026-09-08-1053610) | Waitlists can be large, so the notice path must cost the same for one waiter or two hundred. |
| **US fallback.** Eventbrite turns its waitlist on automatically at sell-out, and the organiser releases spots with a host-set "Time to Respond". | [Eventbrite help 811539](https://www.eventbrite.com/help/en-us/articles/811539), [817355](https://www.eventbrite.com/help/en-us/articles/817355/)                         | An offer timer exists elsewhere; it was rejected here (see the overview).                    |
| **US fallback.** Luma: the host approves waitlisted guests and nothing promotes them automatically.                                              | [Luma help](https://help.luma.com/p/waitlist)                                                                                                                             | The opposite end: fully manual. We chose automatic notice, first to pay.                     |

## DPDP

The Digital Personal Data Protection Rules, 2025 (G.S.R. 846(E)) were published in the Gazette on 13 November 2025 ([Gazette of India](https://egazette.gov.in/WriteReadData/2025/267650.pdf), rule 1). Rules 1, 2 and 17 to 21 apply from that date. Consent-manager registration (rule 4) applies one year later, from 13 November 2026. The substantive duties (rules 3, 5 to 16, 22 and 23, including the consent-notice rule, rule 3) apply 18 months after publication, from 13 May 2027. Secondary commentary: [SCC Online](https://www.scconline.com/blog/post/2025/12/26/digital-personal-data-protection-rules-2025-key-highlights/) and [AZB & Partners](https://www.azbpartners.com/bank/indias-digital-personal-data-protection-act-phased-rollout-and-key-compliance-milestones/).

- A consent notice must be clear, standalone and purpose-specific, with withdrawal and grievance channels. Withdrawal must be as easy as giving consent ([TCSA](https://www.tcsa.in/frameworks/dpdp/consent-management)). **Effect:** the newsletter notice states one purpose, every email carries an unsubscribe link, and a withdrawal writes a withdrawn consent record.
- No source found requires double opt-in. It is kept as best practice and as evidence. See Unverified.
- The TRAI telecom messaging rules (TCCCPR) cover telecom messages. That they exclude email is an inference. See Unverified.

## Gmail and Yahoo bulk-sender rules

From 1 February 2024, Gmail requires senders of more than 5,000 messages a day to Gmail accounts to authenticate with SPF and DKIM, publish a DMARC policy aligned with the From domain, keep the spam rate reported in Postmaster Tools under 0.3 %, and support one-click unsubscribe ([Google Workspace help](https://support.google.com/a/answer/81126)). Yahoo asks bulk senders for SPF, DKIM, a passing DMARC policy of at least `p=none`, a spam rate under 0.3 % and a one-click `List-Unsubscribe` header, preferably the RFC 8058 `POST` method, honoured within two days; it publishes no numeric volume threshold for who counts as a bulk sender ([Yahoo Sender Hub](https://senders.yahooinc.com/best-practices/)). **Effect:** the broadcast always sets both headers, and the unsubscribe `POST` needs no login.

## Resend

From the [Resend pricing page](https://resend.com/pricing): the free plan allows 3,000 emails a month and 100 a day, and a paid plan removes the daily cap. Marketing (Contacts and Broadcasts) is priced by contacts. **Effect:** the free plan cannot send a broadcast to more than 100 people a day, so at go-live the account moves to the owner-selected paid plan (recorded in Notion).

## Indian referral programmes

The Indian programmes reviewed ([Zerodha](https://zerodha.com/z-connect/business-updates/zerodhas-referral-program-is-back), [Upstox](https://upstox.com/refer-and-earn/), [Groww](https://groww.in/p/915-referral-terms-and-conditions) and [Unacademy](https://unacademy.com/helpcenter/category/81000193487/article/81000383213), with [Airbnb](https://thepointsguy.com/news/tips-refer-airbnb-users-for-credit) as a US fallback) share one pattern: a reward vests on an event that is hard to fake, such as a paid transaction or an activated account, with caps and forfeiture terms for self or circular referral. The per-programme detail is kept in Notion. **Effect:** the learner reward vests after a delivered, paid session, with a monthly budget, per-code and yearly caps, and a void on self-dealing.

## Referral fraud in India

Device-farm clusters are the common attack. One vendor analysis of 70 million users describes fraud networks ([VARINDIA](https://www.varindia.com/public/index.php/news/new-jamtaras-shift-focus-to-ecommerce-bureau-analysis-of-70-million-users-reveals-fraud-networks); the data is vendor data), and cloud phones make fake devices cheap ([Group-IB](https://www.group-ib.com/blog/cloud-phones-invisible-threat/)). **Effect:** the strongest control is to vest only after real paid delivery, with caps and a shared-instrument check, and to defer device fingerprinting until abuse appears.

## Tax flags

These are flags for the taxes session, not conclusions.

- Section 393(1) Table Sl. 8(iv) of the Income-tax Act, 2025 (the old section 194R), for transactions from 1 April 2026: 10 % tax deducted at source on business perquisites above ₹20,000 a year, with sales discounts excluded ([Income Tax India](https://www.incometaxindia.gov.in/w/tds-on-benefit-or-perquisite-arising-from-business-or-profession)).
- CGST section 15(3): a discount given before or at the time of supply and shown on the invoice reduces the taxable value. **Effect:** the friend's welcome discount is shown on the invoice.
- How a referral reward is classified is unverified.

## Unverified

- That double opt-in is not legally required for email marketing in India. No source was found that requires it; the absence of a source is not proof.
- That TRAI's TCCCPR excludes email. This is an inference from its scope (telecom messages).
- The referral mechanics of CRED, Topmate and PhonePe. No official page was found.
- How a referral reward is classified under section 393(1) Table Sl. 8(iv) and GST.
- That no Indian ticketing platform has a waitlist. Only that none publishes how it works.

## Deprecated & Superseded Approaches

- **US-first benchmarking.** Earlier notes compared the waitlist and referral designs mainly with US products. India-first sources now lead, and a US source appears only as a labelled fallback.
- **Competitor figures in the repository.** Detailed competitor tables and conversion read-outs do not belong in the repository. They live in Notion; delete any that are added here.
