# Stream.io — Pricing Overview

Quick-reference public price schedule for Stream.io (Video + Chat + Feeds), as published on [Stream's pricing page](https://getstream.io/pricing/) and verified April 23, 2026 via the live pricing calculator and the Maker Account page. Which tier Familiarise runs, and what it costs per month, is not here: value kept in Notion (Familiarise / Finance and Pricing).

For full rate tables and permutation matrices, see [`14-pricing-and-cost-model.md`](./14-pricing-and-cost-model.md).
For Enterprise plans, SLA tiers, AI Moderation, and the Maker-to-paid transition roadmap, see [`15-enterprise-and-maker-account.md`](./15-enterprise-and-maker-account.md).

---

## The Maker Account (Free)

Stream's [Maker Account](https://getstream.io/maker-account/) is a zero-cost tier for early-stage products. Which tier Familiarise is on, and whether it still qualifies: value kept in Notion (Familiarise / Finance and Pricing).

### Eligibility (ALL three must hold simultaneously)

| Requirement            | Condition   |
| ---------------------- | ----------- |
| Team size              | ≤ 5 members |
| Monthly revenue        | < $10K      |
| Funding raised to date | < $100K     |

> **Critical:** The `< $100K in funding` condition is easy to miss. Eligibility is lost when cumulative funding reaches $100K, so a small angel cheque below that total does not end it; compare the running total with the limit.

### What Maker Includes

| Feature        | Hard Limit                                                                                    | Normal Paid Value  |
| -------------- | --------------------------------------------------------------------------------------------- | ------------------ |
| Chat           | **2,000 MAU** (hard cap, pauses)                                                              | $399/mo (10K MAU)  |
| Video          | $100 credit/month (about 66,667 HD or 333,333 audio-only PM), then pay-as-you-go; no hard cap | $0.30–$12.00/1K PM |
| Activity Feeds | 125,000 API calls/month                                                                       | $499/mo (Start)    |
| AI Moderation  | $100 in credits                                                                               | $2/1K msgs (PAYG)  |

> The Chat 2K MAU cap is a **hard pause** — the service stops, it does not bill overages.

---

## Video Pricing (Post-Maker)

The video rate card lives in one place: [`14-pricing-and-cost-model.md`](./14-pricing-and-cost-model.md), section 1.2 for Video Calls and section 2.1 for Live Streaming. It matches Stream's published [pricing guide](https://getstream.io/video/docs/api/pricing-guide/). At 30 fps the anchors are HD (720p) at $1.50 and Full HD (1080p) at $3.00 per 1,000 participant-minutes (PM), and 60 fps doubles every rate.

A participant is billed at the tier of the combined resolution of every video track they receive, not of what they send, and a participant with camera and microphone both off is metered at the cheaper livestream rates. Section 1.5 of the same document explains both rules and what they mean for a webinar with a shared screen.

### Recording Add-on (Video Calls only, unavailable at 2K/4K)

| Quality    | Rate per 1K call-minutes |
| ---------- | ------------------------ |
| Audio Only | $1.50                    |
| SD         | $3.00 ¹                  |
| HD         | $6.00                    |
| Full HD    | $12.00                   |

¹ SD recording rate follows the confirmed doubling pattern (Audio Only $1.50 → SD $3.00 → HD $6.00 → FHD $12.00) but was not directly verified in the calculator — all other rows were.

### Other Add-ons

| Add-on               | Rate               |
| -------------------- | ------------------ |
| Noise Cancellation   | $0.30/1K PM        |
| Transcriptions       | $8.00/1K call-min  |
| RTMP In/Out          | $15.00/1K call-min |
| HLS (Live mode only) | $0.96/1K PM        |

---

## Chat Pricing (Post-Maker)

Pricing as of April 2026 in US dollars. Annual = 2 months free.

| Plan       | MAU     | Annual/mo | Monthly/mo |
| ---------- | ------- | --------- | ---------- |
| Start      | 10K     | $399      | $499       |
| Start      | 25K     | $549      | $699       |
| Start      | 50K     | $749      | $949       |
| Elevate    | 10K     | $499      | $599       |
| Elevate    | 25K     | $649      | $799       |
| Elevate    | 50K     | $899      | $1,099     |
| Enterprise | 1M+ MAU | Custom    | —          |

**Start vs Elevate:** Elevate adds push notifications, message search, content translation, message pinning, advanced moderation (shadow ban, bounce).

---

## Activity Feeds Pricing (Post-Maker)

| Plan    | Price (Annual) | Price (Monthly) |
| ------- | -------------- | --------------- |
| Start   | $499/mo        | $599/mo         |     |
| Elevate | $899/mo        | $999/mo         |     |

---

## The Cost Cliff

Losing any one Maker condition ends the free tier. Stream's public pages do not say how the transition happens, so arrange the paid plan before eligibility ends; Chat then starts at the Start plan price in the Chat table above. The projected rupee cost, the stage-by-stage budget and the GMV level at which to plan for it: value kept in Notion (Familiarise / Finance and Pricing).

### Monitoring

Set a **1,500 MAU alert** (75% of the 2K hard cap) in the Stream dashboard to get advance warning before the Chat service pauses.

> **GST note:** If GST-registered, add 18% IGST under RCM on all Stream.io payments. This is claimable as ITC.

---

## Deprecated & Superseded Approaches

- **Unbounded Default Call Roles (`user` / `guest`)**: Superseded by stripping all billable media permissions from unauthenticated roles so idle accounts never incur participant-minute billing.
- **Per-Plan Recording Storage Tiers (`STREAM_ONLY` / `PERMANENT`)**: Superseded by universal Cloudflare R2 multipart transfer (`transfer-recordings`) so Stream CDN overage storage is never billed.

---

## Related Documents

- [`14-pricing-and-cost-model.md`](./14-pricing-and-cost-model.md) — Full rate matrix with participant-count permutation tables (all qualities × FPS × duration × session count)
- [`15-enterprise-and-maker-account.md`](./15-enterprise-and-maker-account.md) — Enterprise tiers, SLA details, AI Moderation PAYG rates, Familiarise tier roadmap
