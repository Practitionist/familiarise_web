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

The Digital Personal Data Protection Rules were notified on 14 November 2025. Most substantive rules apply 18 months later (about 13 to 14 May 2027), and consent-manager registration comes later. Sources: [SCC Online](https://www.scconline.com/blog/post/2025/12/26/digital-personal-data-protection-rules-2025-key-highlights/) and [AZB & Partners](https://www.azbpartners.com/bank/indias-digital-personal-data-protection-act-phased-rollout-and-key-compliance-milestones/).

- A consent notice must be clear, standalone and purpose-specific, with withdrawal and grievance channels. Withdrawal must be as easy as giving consent ([TCSA](https://www.tcsa.in/frameworks/dpdp/consent-management)). **Effect:** the newsletter notice states one purpose, every email carries an unsubscribe link, and a withdrawal writes a withdrawn consent record.
- No source found requires double opt-in. It is kept as best practice and as evidence. See Unverified.
- The TRAI telecom messaging rules (TCCCPR) cover telecom messages. That they exclude email is an inference. See Unverified.

## Gmail and Yahoo bulk-sender rules

From February 2024, senders above 5,000 messages a day to Gmail or Yahoo must authenticate with SPF, DKIM and an aligned DMARC policy, keep the spam rate under 0.3 %, and support one-click unsubscribe per RFC 8058 with the `List-Unsubscribe` and `List-Unsubscribe-Post` headers ([Google Workspace help](https://support.google.com/a/answer/81126)). **Effect:** the broadcast always sets both headers, and the unsubscribe `POST` needs no login.

## Resend

From the [Resend pricing page](https://resend.com/pricing): the Free plan allows 3,000 emails a month and 100 a day. Pro starts at 50,000 a month with no daily cap. Marketing (Contacts and Broadcasts) is priced by contacts. A dedicated IP comes only on the Scale plan. **Effect:** the free plan cannot send a broadcast to more than 100 people a day, so the account moves to Pro at go-live. Our cost and plan choice are in Notion.

## Indian referral programmes

| Programme               | Mechanism                                                                                                                | Source                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Zerodha                 | 10 % of the referee's brokerage plus points; the referee gets perks.                                                     | [Zerodha Z-Connect](https://zerodha.com/z-connect/business-updates/zerodhas-referral-program-is-back) |
| Upstox                  | Activation within 7 days, rewards after activation, a monthly cap, and self or circular referral banned with forfeiture. | [Upstox](https://upstox.com/refer-and-earn/)                                                          |
| Groww 915               | Referrer only, paid on onboarding.                                                                                       | [Groww terms](https://groww.in/p/915-referral-terms-and-conditions)                                   |
| Unacademy               | Two-sided; the friend gets 5 % off.                                                                                      | [Unacademy help](https://unacademy.com/helpcenter/category/81000193487/article/81000383213)           |
| **US fallback.** Airbnb | Travel credit after a qualifying stay.                                                                                   | [The Points Guy](https://thepointsguy.com/news/tips-refer-airbnb-users-for-credit)                    |

The pattern across them is that a reward vests on an event that is hard to fake, such as a paid transaction, with caps and forfeiture terms. **Effect:** the learner reward vests after a delivered, paid session, with a monthly budget, per-code and yearly caps, and a void on self-dealing.

## Referral fraud in India

Device-farm clusters are the common attack. One vendor analysis of 70 million users describes fraud networks ([VARINDIA](https://www.varindia.com/public/index.php/news/new-jamtaras-shift-focus-to-ecommerce-bureau-analysis-of-70-million-users-reveals-fraud-networks); the data is vendor data), and cloud phones make fake devices cheap ([Group-IB](https://www.group-ib.com/blog/cloud-phones-invisible-threat/)). **Effect:** the strongest control is to vest only after real paid delivery, with caps and a shared-instrument check, and to defer device fingerprinting until abuse appears.

## Tax flags

These are flags for the taxes session, not conclusions.

- Section 194R: 10 % tax deducted at source on business perquisites above ₹20,000 a year, with sales discounts excluded ([Income Tax India](https://www.incometaxindia.gov.in/w/tds-on-benefit-or-perquisite-arising-from-business-or-profession)).
- CGST section 15(3): a discount given before or at the time of supply and shown on the invoice reduces the taxable value. **Effect:** the friend's welcome discount is shown on the invoice.
- How a referral reward is classified is unverified.

## Unverified

- That double opt-in is not legally required for email marketing in India. No source was found that requires it; the absence of a source is not proof.
- That TRAI's TCCCPR excludes email. This is an inference from its scope (telecom messages).
- The referral mechanics of CRED, Topmate and PhonePe. No official page was found.
- How a referral reward is classified under 194R and GST.
- That no Indian ticketing platform has a waitlist. Only that none publishes how it works.

## Deprecated & Superseded Approaches

- **US-first benchmarking.** Earlier notes compared the waitlist and referral designs mainly with US products. India-first sources now lead, and a US source appears only as a labelled fallback.
- **Competitor figures in the repository.** Detailed competitor tables and conversion read-outs do not belong in the repository. They live in Notion; delete any that are added here.
