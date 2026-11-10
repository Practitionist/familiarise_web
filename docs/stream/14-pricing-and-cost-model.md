# Stream.io Pricing — Public Rate Reference

> **Verified:** April 23, 2026 via Chrome DevTools live calculator interaction
> **Exchange rate:** ₹90.7/$1 (Feb 2026 baseline, used only for the rupee conversions below; verify for the current rate)
> **Source:** Stream's published pricing at <https://getstream.io/pricing/> and <https://getstream.io/video/docs/api/pricing-guide/>
> **Products in use:** Video & Audio (video calls + recording), Chat Messaging
> **Products not yet in use:** Activity Feeds, AI Moderation, Vision Agents

---

## 1. Video & Audio Pricing

Stream.io Video uses a **participant-minute (PM)** model: participants × call duration × quality rate. 60 fps doubles the rate. No monthly minimum — the first $100 of usage is free every month for all PAYG accounts.

### 1.1 Free / Build Plan

- **$100 free credit per month** (all PAYG tiers — no credit card required to start)
- Equivalent free capacity at each quality level:

| Quality    | Free PM Equivalent |
| ---------- | ------------------ |
| Audio Only | 333,333 PM         |
| SD         | 133,333 PM         |
| **HD**     | **66,667 PM**      |
| FHD        | 33,333 PM          |
| 2K         | 16,667 PM          |
| 4K         | 8,333 PM           |

> The $100 credit offsets any mix of quality. Values above assume 100% at one quality.

---

### 1.2 Video Calls — Full Rate Matrix

**$/1,000 Participant-Minutes. 60 fps = exactly 2× the 30 fps rate.**

| Quality    | 30 fps $/1K PM | 30 fps ₹/1K PM | 60 fps $/1K PM | 60 fps ₹/1K PM | Multiplier vs SD |
| ---------- | -------------- | -------------- | -------------- | -------------- | ---------------- |
| Audio Only | $0.30          | ₹27            | $0.60          | ₹54            | 0.4×             |
| SD         | $0.75          | ₹68            | $1.50          | ₹136           | 1×               |
| **HD**     | **$1.50**      | **₹136**       | **$3.00**      | **₹272**       | **2×**           |
| FHD        | $3.00          | ₹272           | $6.00          | ₹544           | 4×               |
| 2K         | $6.00          | ₹544           | $12.00         | ₹1,089         | 8×               |
| 4K         | $12.00         | ₹1,089         | $24.00         | ₹2,177         | 16×              |

**Formula:** `cost = participants × avg_duration_min × sessions_per_month / 1000 × rate`

---

### 1.3 Video Calls — HD 30fps Comprehensive Cost Table

**HD 30fps ($1.50/1K PM) — Familiarise default quality.**  
Monthly cost in USD. Subtract $100 free credit for actual billed amount.

#### 2 Participants — 1-on-1 consultations

| Duration (min) | 50 sessions | 100 sessions | 250 sessions | 500 sessions | 1,000 sessions | 2,500 sessions | 5,000 sessions | 10,000 sessions |
| -------------- | ----------- | ------------ | ------------ | ------------ | -------------- | -------------- | -------------- | --------------- |
| 15             | $2.25       | $4.50        | $11.25       | $22.50       | $45.00         | $112.50        | $225.00        | $450.00         |
| 30             | $4.50       | $9.00        | $22.50       | $45.00       | $90.00         | $225.00        | $450.00        | $900.00         |
| 45             | $6.75       | $13.50       | $33.75       | $67.50       | $135.00        | $337.50        | $675.00        | $1,350.00       |
| 60             | $9.00       | $18.00       | $45.00       | $90.00       | **$180.00**    | $450.00        | $900.00        | $1,800.00       |
| 90             | $13.50      | $27.00       | $67.50       | $135.00      | $270.00        | $675.00        | $1,350.00      | $2,700.00       |
| 120            | $18.00      | $36.00       | $90.00       | $180.00      | $360.00        | $900.00        | $1,800.00      | $3,600.00       |
| 180            | $27.00      | $54.00       | $135.00      | $270.00      | $540.00        | $1,350.00      | $2,700.00      | $5,400.00       |
| 240            | $36.00      | $72.00       | $180.00      | $360.00      | $720.00        | $1,800.00      | $3,600.00      | $7,200.00       |

#### 4 Participants — small group / panel

| Duration (min) | 50 sessions | 100 sessions | 250 sessions | 500 sessions | 1,000 sessions | 2,500 sessions | 5,000 sessions | 10,000 sessions |
| -------------- | ----------- | ------------ | ------------ | ------------ | -------------- | -------------- | -------------- | --------------- |
| 15             | $4.50       | $9.00        | $22.50       | $45.00       | $90.00         | $225.00        | $450.00        | $900.00         |
| 30             | $9.00       | $18.00       | $45.00       | $90.00       | $180.00        | $450.00        | $900.00        | $1,800.00       |
| 45             | $13.50      | $27.00       | $67.50       | $135.00      | $270.00        | $675.00        | $1,350.00      | $2,700.00       |
| 60             | $18.00      | $36.00       | $90.00       | $180.00      | **$360.00**    | $900.00        | $1,800.00      | $3,600.00       |
| 90             | $27.00      | $54.00       | $135.00      | $270.00      | $540.00        | $1,350.00      | $2,700.00      | $5,400.00       |
| 120            | $36.00      | $72.00       | $180.00      | $360.00      | $720.00        | $1,800.00      | $3,600.00      | $7,200.00       |
| 180            | $54.00      | $108.00      | $270.00      | $540.00      | $1,080.00      | $2,700.00      | $5,400.00      | $10,800.00      |
| 240            | $72.00      | $144.00      | $360.00      | $720.00      | $1,440.00      | $3,600.00      | $7,200.00      | $14,400.00      |

#### 6 Participants — small class / team session

| Duration (min) | 50 sessions | 100 sessions | 250 sessions | 500 sessions | 1,000 sessions | 2,500 sessions | 5,000 sessions |
| -------------- | ----------- | ------------ | ------------ | ------------ | -------------- | -------------- | -------------- |
| 30             | $13.50      | $27.00       | $67.50       | $135.00      | $270.00        | $675.00        | $1,350.00      |
| 60             | $27.00      | $54.00       | $135.00      | $270.00      | $540.00        | $1,350.00      | $2,700.00      |
| 90             | $40.50      | $81.00       | $202.50      | $405.00      | $810.00        | $2,025.00      | $4,050.00      |
| 120            | $54.00      | $108.00      | $270.00      | $540.00      | $1,080.00      | $2,700.00      | $5,400.00      |
| 180            | $81.00      | $162.00      | $405.00      | $810.00      | $1,620.00      | $4,050.00      | $8,100.00      |

#### 10 Participants — group workshop

| Duration (min) | 10 sessions | 50 sessions | 100 sessions | 250 sessions | 500 sessions | 1,000 sessions | 2,500 sessions |
| -------------- | ----------- | ----------- | ------------ | ------------ | ------------ | -------------- | -------------- |
| 30             | $4.50       | $22.50      | $45.00       | $112.50      | $225.00      | $450.00        | $1,125.00      |
| 60             | $9.00       | $45.00      | $90.00       | $225.00      | $450.00      | $900.00        | $2,250.00      |
| 90             | $13.50      | $67.50      | $135.00      | $337.50      | $675.00      | $1,350.00      | $3,375.00      |
| 120            | $18.00      | $90.00      | $180.00      | $450.00      | $900.00      | $1,800.00      | $4,500.00      |
| 180            | $27.00      | $135.00     | $270.00      | $675.00      | $1,350.00    | $2,700.00      | $6,750.00      |
| 240            | $36.00      | $180.00     | $360.00      | $900.00      | $1,800.00    | $3,600.00      | $9,000.00      |

#### 20 Participants — class / bootcamp

| Duration (min) | 10 sessions | 50 sessions | 100 sessions | 250 sessions | 500 sessions | 1,000 sessions |
| -------------- | ----------- | ----------- | ------------ | ------------ | ------------ | -------------- |
| 30             | $9.00       | $45.00      | $90.00       | $225.00      | $450.00      | $900.00        |
| 60             | $18.00      | $90.00      | $180.00      | $450.00      | $900.00      | $1,800.00      |
| 90             | $27.00      | $135.00     | $270.00      | $675.00      | $1,350.00    | $2,700.00      |
| 120            | $36.00      | $180.00     | $360.00      | $900.00      | $1,800.00    | $3,600.00      |
| 180            | $54.00      | $270.00     | $540.00      | $1,350.00    | $2,700.00    | $5,400.00      |

#### 50 Participants — large class / cohort

| Duration (min) | 5 sessions | 10 sessions | 25 sessions | 50 sessions | 100 sessions | 250 sessions |
| -------------- | ---------- | ----------- | ----------- | ----------- | ------------ | ------------ |
| 30             | $11.25     | $22.50      | $56.25      | $112.50     | $225.00      | $562.50      |
| 60             | $22.50     | $45.00      | $112.50     | $225.00     | $450.00      | $1,125.00    |
| 90             | $33.75     | $67.50      | $168.75     | $337.50     | $675.00      | $1,687.50    |
| 120            | $45.00     | $90.00      | $225.00     | $450.00     | $900.00      | $2,250.00    |
| 180            | $67.50     | $135.00     | $337.50     | $675.00     | $1,350.00    | $3,375.00    |
| 240            | $90.00     | $180.00     | $450.00     | $900.00     | $1,800.00    | $4,500.00    |

#### 100 Participants — webinar

| Duration (min) | 5 sessions | 10 sessions | 25 sessions | 50 sessions | 100 sessions | 250 sessions |
| -------------- | ---------- | ----------- | ----------- | ----------- | ------------ | ------------ |
| 30             | $22.50     | $45.00      | $112.50     | $225.00     | $450.00      | $1,125.00    |
| 60             | $45.00     | $90.00      | $225.00     | $450.00     | $900.00      | $2,250.00    |
| 90             | $67.50     | $135.00     | $337.50     | $675.00     | $1,350.00    | $3,375.00    |
| 120            | $90.00     | $180.00     | $450.00     | $900.00     | $1,800.00    | $4,500.00    |
| 180            | $135.00    | $270.00     | $675.00     | $1,350.00   | $2,700.00    | $6,750.00    |

#### 200 Participants — maximum, large webinar / event

| Duration (min) | 5 sessions | 10 sessions | 25 sessions | 50 sessions | 100 sessions |
| -------------- | ---------- | ----------- | ----------- | ----------- | ------------ |
| 30             | $45.00     | $90.00      | $225.00     | $450.00     | $900.00      |
| 60             | $90.00     | $180.00     | $450.00     | $900.00     | $1,800.00    |
| 90             | $135.00    | $270.00     | $675.00     | $1,350.00   | $2,700.00    |
| 120            | $180.00    | $360.00     | $900.00     | $1,800.00   | $3,600.00    |
| 180            | $270.00    | $540.00     | $1,350.00   | $2,700.00   | $5,400.00    |
| 240            | $360.00    | $720.00     | $1,800.00   | $3,600.00   | $7,200.00    |

> **Annual billing saves ~10%** at the Enterprise tier. PAYG is month-to-month by default.

---

### 1.4 Cross-Quality Cost Comparison

**Scenario A:** 2 participants × 60 min × 500 sessions = **60,000 PM/month**

| Quality    | 30fps Rate   | Monthly Cost | After $100 credit | INR/mo (billed) |
| ---------- | ------------ | ------------ | ----------------- | --------------- |
| Audio Only | $0.30/1K     | $18.00       | **$0**            | ₹0              |
| SD         | $0.75/1K     | $45.00       | **$0**            | ₹0              |
| **HD**     | **$1.50/1K** | **$90.00**   | **$0**            | ₹0              |
| FHD        | $3.00/1K     | $180.00      | $80.00            | ₹7,256          |
| 2K         | $6.00/1K     | $360.00      | $260.00           | ₹23,582         |
| 4K         | $12.00/1K    | $720.00      | $620.00           | ₹56,234         |

**Scenario B:** 2 participants × 60 min × 1,000 sessions = **120,000 PM/month**

| Quality    | 30fps Rate   | Monthly Cost | After $100 credit | INR/mo (billed) |
| ---------- | ------------ | ------------ | ----------------- | --------------- |
| Audio Only | $0.30/1K     | $36.00       | **$0**            | ₹0              |
| SD         | $0.75/1K     | $90.00       | **$0**            | ₹0              |
| **HD**     | **$1.50/1K** | **$180.00**  | **$80.00**        | ₹7,256          |
| FHD        | $3.00/1K     | $360.00      | $260.00           | ₹23,582         |
| 2K         | $6.00/1K     | $720.00      | $620.00           | ₹56,234         |
| 4K         | $12.00/1K    | $1,440.00    | $1,340.00         | ₹121,538        |

**60 fps doubles every cost in both tables above.**

### 1.5 How Stream decides the billed tier

Stream's own pages describe the billed tier in two different ways, and both were read on 2026-11-07. The [pricing guide](https://getstream.io/video/docs/api/pricing-guide/) says "we calculate charges based on each user's total resolution of receiving tracks (aggregated resolution)", which is the tier that matches the combined resolution of every video track a participant receives at the same moment. The FAQ entry "How do you measure the video quality?" on the [pricing page](https://getstream.io/video/pricing/) says instead that "the quality is priced at the highest quality level the user is publishing or receiving".

The two readings differ only for a participant who publishes video. Under the FAQ reading, a presenter who publishes a 720p camera is billed at HD at least, even while receiving only SD. An attendee who publishes nothing is billed at the received tier under either reading. This section follows the pricing guide's received-track rule, and nobody has yet checked against an invoice which reading Stream applies. The combined resolution is the sum of the pixels of all received tracks:

| Combined pixels received | Tier billed     |
| ------------------------ | --------------- |
| up to 308K               | SD (480p)       |
| up to 921,600            | HD (720p)       |
| up to 2,073,600          | Full HD (1080p) |
| up to 3,686,400          | 2K              |
| up to 8,847,360          | 4K              |

Three rules from the same guide decide what a webinar costs:

1. A screen share is one more received track, and it does not use Dynascale, so it arrives at the resolution the sender publishes. Camera tracks, by contrast, are scaled down to what the viewer's screen can show.
2. Stream's own example: a viewer who receives two HD tracks (2 × 1280 × 720 = 1,843,200 pixels) is billed at the Full HD rate.
3. A participant whose camera and microphone are both off is metered as a livestream viewer, at the cheaper livestream rates in section 2.1, even inside a normal video call.

Worked example (derived from those rules and this platform's defaults, not measured). Webinar attendees join muted with their cameras off, because `buildCallSettingsOverride` in `lib/meetings/room-ready.ts` applies the backstage and muted defaults to webinars and classes, so rule 3 applies to them. The default quality is a 720p camera and a 1080p screen share (`DEFAULT_VIDEO_CONFIG` in `lib/stream/video-quality.ts`; section 8.2). One hundred attendees watching for 90 minutes is 9,000 participant minutes:

| What the attendee receives                                         | Combined pixels | Billed as a livestream viewer (rule 3)       | Billed at the call rates of section 1.2       |
| ------------------------------------------------------------------ | --------------- | -------------------------------------------- | --------------------------------------------- |
| The host's camera only (at most 720p, less after Dynascale)        | at most 921,600 | HD at most, $1.00 per 1,000: **up to $9.00** | HD at most, $1.50 per 1,000: **up to $13.50** |
| The host's camera and a shared 1080p screen (2,073,600 + a camera) | above 2,073,600 | 2K, $4.00 per 1,000: **$36.00**              | 2K, $6.00 per 1,000: **$54.00**               |

At ₹90.7 to the dollar those are about ₹816, ₹3,265, ₹1,224 and ₹4,898. The camera-only figures are ceilings: a camera that Dynascale scales down to SD (up to 308K pixels) bills at the SD rate, $0.50 per 1,000 as a livestream viewer, or $4.50. The practical reading is that a webinar with a shared screen costs roughly four times the camera-only ceiling, because any camera added to a 1080p share pushes the viewer past the Full HD threshold into 2K. A second presenter camera on top of that share adds up to 921,600 more pixels (3,916,800 in total), which passes the 2K ceiling of 3,686,400 and bills at the 4K tier ($12.00 per 1,000 at call rates, $8.00 as a livestream viewer) whenever Dynascale does not scale the cameras down. Three points are inferred from Stream's text and have not been checked against an invoice: that the livestream rate applies to a muted attendee at the combined tier, that an attendee promoted to the stage stops being a livestream viewer, and whether a presenter's own published camera also sets that presenter's tier, as the pricing page's FAQ says. Until a real month of usage is read from the Stream dashboard, treat the livestream column as the floor and the call-rate column as the ceiling.

---

## 2. Live Streaming Pricing

Same PM model, lower rates (~67% of Video Calls for SD–4K, 40% for Audio Only). Max participants slider shows 200 in VC mode but defaults to 1,000 viewers in LS mode. Use Live Streaming mode for large audiences viewing a single host stream.

### 2.1 Live Streaming Rate Matrix

| Quality    | 30 fps $/1K PM | 30 fps ₹/1K PM | 60 fps $/1K PM | vs Video Calls (30fps) |
| ---------- | -------------- | -------------- | -------------- | ---------------------- |
| Audio Only | $0.12          | ₹11            | $0.24          | 40%                    |
| SD         | $0.50          | ₹45            | $1.00          | 67%                    |
| **HD**     | **$1.00**      | **₹91**        | **$2.00**      | **67%**                |
| FHD        | $2.00          | ₹181           | $4.00          | 67%                    |
| 2K         | $4.00          | ₹363           | $8.00          | 67%                    |
| 4K         | $8.00          | ₹726           | $16.00         | 67%                    |

### 2.2 Live Streaming — HD 30fps Cost Table ($1.00/1K PM)

| Viewers | Duration (min) | 5 sessions | 10 sessions | 25 sessions | 50 sessions | 100 sessions | 250 sessions |
| ------- | -------------- | ---------- | ----------- | ----------- | ----------- | ------------ | ------------ |
| 100     | 30             | $1.50      | $3.00       | $7.50       | $15.00      | $30.00       | $75.00       |
| 100     | 60             | $3.00      | $6.00       | $15.00      | $30.00      | $60.00       | $150.00      |
| 100     | 90             | $4.50      | $9.00       | $22.50      | $45.00      | $90.00       | $225.00      |
| 500     | 30             | $7.50      | $15.00      | $37.50      | $75.00      | $150.00      | $375.00      |
| 500     | 60             | $15.00     | $30.00      | $75.00      | $150.00     | $300.00      | $750.00      |
| 500     | 90             | $22.50     | $45.00      | $112.50     | $225.00     | $450.00      | $1,125.00    |
| 1,000   | 30             | $15.00     | $30.00      | $75.00      | $150.00     | $300.00      | $750.00      |
| 1,000   | 60             | $30.00     | $60.00      | $150.00     | $300.00     | $600.00      | $1,500.00    |
| 1,000   | 90             | $45.00     | $90.00      | $225.00     | $450.00     | $900.00      | $2,250.00    |
| 1,000   | 120            | $60.00     | $120.00     | $300.00     | $600.00     | $1,200.00    | $3,000.00    |
| 5,000   | 60             | $150.00    | $300.00     | $750.00     | $1,500.00   | $3,000.00    | $7,500.00    |
| 10,000  | 60             | $300.00    | $600.00     | $1,500.00   | $3,000.00   | $6,000.00    | $15,000.00   |
| 50,000  | 60             | $1,500.00  | $3,000.00   | $7,500.00   | $15,000.00  | $30,000.00   | $75,000.00   |

### 2.3 HLS Live Streaming Add-on

Adds HLS delivery on top of the base Live Streaming charge. Only available in Live Streaming mode (disabled for Video Calls).

**Rate: $0.96 per 1,000 participant-minutes** (₹87/1K PM)

HLS adds ~96% of base cost — effectively almost doubles the Live Streaming bill.

| Viewers | Duration (min) | Sessions/mo | Base LS (HD) | HLS Add-on | Total     | ₹/mo     |
| ------- | -------------- | ----------- | ------------ | ---------- | --------- | -------- |
| 100     | 60             | 10          | $6.00        | $5.76      | $11.76    | ₹1,067   |
| 500     | 60             | 10          | $30.00       | $28.80     | $58.80    | ₹5,333   |
| 1,000   | 60             | 10          | $60.00       | $57.60     | $117.60   | ₹10,676  |
| 1,000   | 60             | 25          | $150.00      | $144.00    | $294.00   | ₹26,672  |
| 1,000   | 90             | 10          | $90.00       | $86.40     | $176.40   | ₹16,007  |
| 5,000   | 60             | 10          | $300.00      | $288.00    | $588.00   | ₹53,360  |
| 10,000  | 60             | 10          | $600.00      | $576.00    | $1,176.00 | ₹106,711 |

**Budget: HD + HLS = $1.96/1K PM total in Live Streaming mode.**

---

## 3. Recording Add-on

Billed per **call minute** (not per participant-minute). Rate doubles with each quality tier. Not available for 2K or 4K.

### 3.1 Recording Rate by Quality

| Quality    | Rate / 1K call-min | ₹ / 1K call-min | Quality pattern | Available |
| ---------- | ------------------ | --------------- | --------------- | --------- |
| Audio Only | $1.50              | ₹136            | base            | ✅        |
| SD         | $3.00              | ₹272            | 2× AO           | ✅        |
| **HD**     | **$6.00**          | **₹544**        | **4× AO**       | ✅        |
| FHD        | $12.00             | ₹1,089          | 8× AO           | ✅        |
| 2K         | —                  | —               | —               | ❌        |
| 4K         | —                  | —               | —               | ❌        |

### 3.2 Recording Cost — HD ($6.00/1K call-min)

| Avg duration (min) | 50 sessions | 100 sessions | 250 sessions | 500 sessions | 1,000 sessions | 2,500 sessions |
| ------------------ | ----------- | ------------ | ------------ | ------------ | -------------- | -------------- |
| 15                 | $4.50       | $9.00        | $22.50       | $45.00       | $90.00         | $225.00        |
| 30                 | $9.00       | $18.00       | $45.00       | $90.00       | $180.00        | $450.00        |
| 45                 | $13.50      | $27.00       | $67.50       | $135.00      | $270.00        | $675.00        |
| 60                 | $18.00      | $36.00       | $90.00       | $180.00      | $360.00        | $900.00        |
| 90                 | $27.00      | $54.00       | $135.00      | $270.00      | $540.00        | $1,350.00      |
| 120                | $36.00      | $72.00       | $180.00      | $360.00      | $720.00        | $1,800.00      |

### 3.3 Recording Cost — All Qualities (60 min/session, 500 sessions/month)

Call-minutes = 60 × 500 = 30,000

| Quality    | Rate/1K   | Recording cost | Base video cost (2 participants) | Combined    |
| ---------- | --------- | -------------- | -------------------------------- | ----------- |
| Audio Only | $1.50     | $45.00         | $18.00                           | $63.00      |
| SD         | $3.00     | $90.00         | $45.00                           | $135.00     |
| **HD**     | **$6.00** | **$180.00**    | **$90.00**                       | **$270.00** |
| FHD        | $12.00    | $360.00        | $180.00                          | $540.00     |

After $100 credit: HD combined = $270 − $100 = **$170/month** (₹15,419/month).

### 3.4 Where the recorded file lives

The platform records HD (720p, composite, spotlight layout) unless staff raise it to Full HD on the Video quality page (section 8.2), so the HD rate in 3.2 is the one that applies by default. Stream holds each file for 14 days; the `transfer-recordings` job then copies it to Cloudflare R2, which costs $0.015 per GB-month with free egress ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)). Recording capture, not storage, is the dominant cost, and the platform retention schedule (90 days for 1:1, 365 days for group sessions) bounds the stored volume. Cloudflare Stream was rejected as the host because its storage costs roughly 20 times R2; it stays a candidate only for a paid adaptive-bitrate replay library.

---

## 4. Other Add-on Rates

Verified from the Stream pricing page (April 2026). All PAYG, no monthly minimum.

| Add-on              | Unit            | Rate (USD) | Rate (INR) | Notes                      |
| ------------------- | --------------- | ---------- | ---------- | -------------------------- |
| Noise Cancellation  | per 1K PM       | $0.30      | ₹27        | All modes                  |
| Transcriptions / CC | per 1K call-min | $8.00      | ₹726       | All modes                  |
| RTMP In             | per 1K call-min | $15.00     | ₹1,361     | Ingest external stream     |
| RTMP Out            | per 1K call-min | $15.00     | ₹1,361     | Broadcast to RTMP endpoint |
| HLS Live Streaming  | per 1K PM       | $0.96      | ₹87        | Live Streaming mode only   |
| HIPAA Compliance    | custom          | Contact Us | —          | Enterprise                 |

**Noise Cancellation:** 2 participants × 60 min × 1,000 sessions = 120,000 PM → **$36/month**  
**Transcriptions:** 60 min × 500 sessions = 30,000 call-min → **$240/month**  
**RTMP Out (broadcast):** 60 min × 500 sessions = 30,000 call-min → **$450/month**

---

## 5. Chat Messaging Pricing

### 5.1 Full Plan Matrix — All MAU Tiers × Billing Cycles

| MAU Tier | Plan    | Annual/mo | Monthly | INR/mo (annual) | INR/mo (monthly) | Savings vs monthly/yr |
| -------- | ------- | --------- | ------- | --------------- | ---------------- | --------------------- |
| **10K**  | Start   | $399      | $499    | ₹36,189         | ₹45,269          | $1,200/yr             |
| **10K**  | Elevate | $599      | $675    | ₹54,329         | ₹61,223          | $912/yr               |
| **25K**  | Start   | $1,049    | $1,299  | ₹95,144         | ₹117,849         | $3,000/yr             |
| **25K**  | Elevate | $1,299    | $1,599  | ₹117,849        | ₹145,029         | $3,600/yr             |
| **50K**  | Start   | $1,849    | $2,299  | ₹167,705        | ₹208,579         | $5,400/yr             |
| **50K**  | Elevate | $2,299    | $2,799  | ₹208,579        | ₹253,869         | $6,000/yr             |

### 5.2 What Each Tier Includes

| Feature                | Free (Build) | Start 10K        | Elevate 10K      | Start 50K        | Elevate 50K      |
| ---------------------- | ------------ | ---------------- | ---------------- | ---------------- | ---------------- |
| MAU                    | 1,000        | 10,000           | 10,000           | 50,000           | 50,000           |
| Concurrent connections | 100          | 500              | 500              | 2,500            | 2,500            |
| Message storage        | Limited      | Up to 2.5M       | Up to 2.5M       | Up to 10M        | Up to 10M        |
| MAU overage            | —            | $0.09/user       | $0.09/user       | $0.07/user       | $0.07/user       |
| Concurrent overage     | —            | $0.99/concurrent | $0.99/concurrent | $0.79/concurrent | $0.79/concurrent |
| Advanced Moderation    | ❌           | ✅               | ✅               | ✅               | ✅               |
| Data Export            | ❌           | ✅               | ✅               | ✅               | ✅               |
| Offline Support        | ❌           | ✅               | ✅               | ✅               | ✅               |
| HIPAA                  | ❌           | ❌               | ✅               | ❌               | ✅               |
| Multi-Tenancy / Teams  | ❌           | ❌               | ✅               | ❌               | ✅               |
| Advanced Search        | ❌           | ❌               | ✅               | ❌               | ✅               |
| Message Translations   | ❌           | ❌               | ✅               | ❌               | ✅               |

### 5.3 CDN / Storage Overages

| Metric                  | Rate                 |
| ----------------------- | -------------------- |
| CDN Bandwidth           | $0.17/GB             |
| CDN Storage             | $0.07/GB             |
| Monthly Resized Images  | $5.80 / 1,000 images |
| Message storage overage | $0.000015/message    |
| Channel overage         | $0.0012/channel      |

---

## 6. Activity Feeds Pricing

Not currently in use. Relevant if adding notification feeds, expert activity timelines, or social-style features.

| Plan       | Annual/mo | Monthly | API Calls/mo | Activities/mo | INR/mo (annual) |
| ---------- | --------- | ------- | ------------ | ------------- | --------------- |
| Free       | $0        | $0      | 125,000      | 5,000         | ₹0              |
| Start      | $499      | $599    | 1,250,000    | 50,000        | ₹45,269         |
| Elevate    | $899      | $999    | 3,750,000    | 150,000       | ₹81,539         |
| Enterprise | Custom    | Custom  | Custom       | Custom        | —               |

Overage: $25 per 1,000 excess activities.

---

## 7. Maker Account

Stream waives the Chat subscription while all **three** conditions hold **simultaneously**:

| Condition            | Limit                       |
| -------------------- | --------------------------- |
| Team members         | **≤ 5**                     |
| Total funding raised | **< $100,000**              |
| Monthly revenue      | **< $10,000** (~₹9.07 lakh) |

Must be explicitly applied for in the Stream dashboard. Availability is limited and subject to re-qualification. Whether Familiarise meets the conditions today: value kept in Notion (Familiarise / Finance and Pricing).

**Maker Chat is a modified Start Plan:** MAU capped at **2,000** (not 10K) with **hard limits**: no overage billing, and the service pauses at the ceiling.

**Cliff:** Losing any one condition ends Maker eligibility, and Chat is then priced at $499/mo (monthly) or $399/mo (annual). Stream's public pages do not say how or when the transition happens, so arrange the paid plan with Stream before eligibility ends rather than expecting it to activate on its own. See `15-enterprise-and-maker-account.md` for the transition details.

---

## 8. Video cost at the design limits

Familiarise's own monthly video cost projections at expected booking volumes: value kept in Notion (Familiarise / Finance and Pricing). The matrices in section 1.3 give the public arithmetic for any session size and count.

### 8.1 The 200-participant cap

Webinars and classes are capped at 200 participants at launch ([ADR-07](./18-architecture-decision-records.md#adr-07-interactive-webrtc-with-a-200-participant-cap-not-hls-at-launch)), enforced when a plan is authored and when a seat is sold. The call's Stream `limits.max_participants` is the capacity plus a headroom of 5 and exempts the owner and the `co_presenter` and `admin` roles (`lib/meetings/room-ready.ts`), so it is a backstop, not an exact 200. The cap exists so that the largest room Familiarise can sell has a known cost. At the HD rate ($1.50 per 1,000 participant minutes), a full 200-attendee webinar of 90 minutes is 18,000 participant minutes, about $27 (roughly ₹2,450), and a full 200-student class of 60 minutes is 12,000 participant minutes, about $18 (roughly ₹1,630). Those figures count attendees only (the host and co-presenters add their own minutes) and use the plain HD call rate; section 1.5 shows how a shared screen moves a viewer to a higher tier and how muted attendees are metered at the livestream rates. Live Streaming with HLS (section 2.3) would cost more per viewer-minute and add 10 to 30 seconds of delay, which is why audiences above the cap are not routed to it. The cap can be lifted after a load test.

### 8.2 What 1080p costs

Staff can raise call video, screen share and recording quality on the back-office Video quality page; the defaults are the cheapest sensible choice (720p calls, 720p recordings, 1080p screen share). Two charges move when quality rises. Received video is billed per participant-minute at the received resolution (section 1.5 covers the FAQ's publishing-or-receiving reading), so 1080p is $3.00 per 1,000 participant minutes against $1.50 at 720p. Recording is billed per call minute, so Full HD is $12 per 1,000 call-minutes against $6 for HD. A 60-minute consultation with two participants is 120 participant minutes, so it costs about $0.36 in received video at 1080p against $0.18 at 720p, and 60 call minutes cost about $0.72 to record at Full HD against $0.36 at HD; a month of 500 such sessions adds about $90 of video and $180 of recording. Screen share is encoded once and counts as received video, so its 1080p default costs far less than raising every camera. Stream recording tops out at 1440p and the page does not offer 4K.

---

## 9. The Stream.io Cost Cliff

Stream is free on the Maker Account and then steps up to the Chat plan price in section 5. The chosen tier, the projected rupee cost at each step and the planning rules: value kept in Notion (Familiarise / Finance and Pricing). The public price steps are the plan tables in section 5.1.

---

## 10. Enterprise Plan

Threshold: 1M+ participant-minutes/month. Features:

- 99.999% SLA
- Shared Slack channel with engineers
- 24/7 support
- SOC 2 compliant
- Volume discounts (larger than standard annual discount)
- Dedicated regional infrastructure option

Contact: `getstream.io/contact/`

---

## Related Documents

- `UPSTASH_PRICING.md` — Upstash Redis, QStash, Vector, Workflow pricing
- `docs/stream/` — Stream integration technical docs
- `docs/stream/00-pricing-overview.md` — Stream pricing quick reference and cost cliff summary
- Screenshots: `docs/stream-video-pricing-apr2026.png`, `docs/stream-chat-pricing-apr2026.png`, `docs/stream-feeds-pricing-apr2026.png`

---

## Deprecated & Superseded Approaches

- **Separate `livestream` Call Type + HLS Transcoding for Small Cohorts**: Superseded by running webinars/classes (< 100 concurrent participants) on the hardened `default` WebRTC call type with Backstage and muted/camera-off defaults, leveraging Stream Dynascale viewer rates with zero HLS egress fees.
