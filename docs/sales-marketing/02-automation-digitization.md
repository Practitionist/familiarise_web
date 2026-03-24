# Automation & Digitization Playbook — The 2-Person Marketing Machine

**Last updated:** March 2026
**Purpose:** How a 2-person bootstrapped team runs marketing at the level of a 10-person team using automation, tools, and workflows.

---

## Chapter 1: The Time Budget Reality

### Available Hours

| Person | Hours/Week | Role |
|--------|-----------|------|
| Founder (you) | 50-60 | Sales, product, marketing, ops, support |
| Dev (Shubham) | 40 | Building, bug fixes, infra, some support |
| **Total** | **90-100** | |

### Time Allocation — Month 1-3

| Activity | Founder (hrs/wk) | Dev (hrs/wk) |
|----------|-------------------|---------------|
| Sales outreach (messages, demos) | 15 | 0 |
| Content creation (posts, blog) | 5 | 0 |
| Consultant support & onboarding | 5 | 2 |
| Marketing automation setup | 3 | 3 |
| Product decisions | 5 | 5 |
| Building & shipping | 5 | 25 |
| Ops & admin | 5 | 3 |
| Support | 5 | 2 |
| **Total** | **48** | **40** |

### The Automation Rule

**Any manual process that takes more than 2 hours per week MUST be automated or eliminated.**

This is not a suggestion. At your scale, every hour wasted on repetitive tasks is an hour not spent on sales outreach (the highest-leverage activity).

---

## Chapter 2: The Full Automation Stack

### Tier 1: Free (₹0/month) — Start Here

| Tool | Purpose | Free Tier Limits | Setup Time |
|------|---------|-----------------|------------|
| **Google Sheets** | CRM, pipeline tracking, consultant database | Unlimited | 1 hour |
| **Google Calendar** | Demo call scheduling, availability | Unlimited | 30 min |
| **Canva** | Social media graphics, one-pagers, leaflets | 5 designs saved | 2 hours |
| **Buffer** | Social media scheduling (LinkedIn, Twitter) | 3 channels, 10 posts/queue | 30 min |
| **Tally.so** | Consultant application forms, feedback surveys | Unlimited forms & submissions | 1 hour |
| **Tawk.to** | Live chat widget on website | Unlimited | 30 min |
| **Google Search Console** | SEO monitoring, keyword tracking | Unlimited | 1 hour |
| **Google Analytics 4** | Website analytics, user behavior | Unlimited | 1 hour |
| **Microsoft Clarity** | Heatmaps, session recordings, user behavior | Unlimited | 30 min |
| **Notion** | Internal wiki, SOPs, content calendar | Free for personal | 2 hours |

**Total cost: ₹0/month. Total setup time: ~10 hours (one weekend).**

### Tier 2: Low Cost (₹2-5K/month) — Add in Month 2

| Tool | Purpose | Cost/Month | Why |
|------|---------|-----------|-----|
| **AiSensy** | WhatsApp Business API (notifications, reminders) | ₹1,500 | 98% open rate. Critical for India. Booking confirmations, session reminders, review requests. |
| **Brevo (formerly Sendinblue)** | Email marketing + automation | ₹0 (300 emails/day free) → ₹750 (starter) | Automated email sequences for onboarding, follow-ups, newsletters |
| **Snov.io** | Email finder + verification | ₹0 (50 credits free) → ₹3,300 ($39) | Find emails of TopMate creators, conference speakers for cold outreach |

**Total: ₹1,500-5,550/month depending on usage.**

### Tier 3: Medium Cost (₹5-15K/month) — Add in Month 4+

| Tool | Purpose | Cost/Month | Why |
|------|---------|-----------|-----|
| **Apollo.io** | B2B database, email enrichment, outreach sequences | ₹0 (10K credits free) → ₹4,200 ($49) | Scale beyond LinkedIn. Find consultant emails by role, company, location. |
| **Make.com (formerly Integromat)** | Workflow automation (multi-app triggers) | ₹0 (1,000 ops free) → ₹760 ($9) | Connect platform events to email/WhatsApp/Sheets automatically |
| **Zoho CRM** | Full CRM (free for ≤3 users) | ₹0 | Upgrade from Google Sheets when pipeline > 200 contacts |
| **PostHog** | Product analytics, feature flags | ₹0 (self-hosted or 1M events free) | Track which features consultants actually use |

**Total: ₹760-4,960/month.**

### Recommended Stack by Month

| Month | Stack | Total Cost |
|-------|-------|-----------|
| 1 | Google Sheets + Canva + Buffer + Tally + Tawk.to + GA4 + Clarity | **₹0** |
| 2-3 | Add AiSensy + Brevo free | **₹1,500** |
| 4-6 | Add Snov.io + Make.com | **₹3,500-5,000** |
| 7+ | Add Apollo.io + Zoho CRM | **₹5,000-8,000** |

---

## Chapter 3: Key Automation Workflows

### Workflow 1: Consultant Onboarding Automation

**Trigger:** Consultant fills application form on Tally.so

**Automated sequence:**

```
[Consultant fills Tally form]
        ↓
[Tally webhook → Google Sheets] (auto-add to CRM)
        ↓
[Brevo email: "Welcome! Here's how to set up your profile" + profile creation link]
        ↓
[Google Calendar reminder: "Follow up with [Name] in 48 hours"]
        ↓
[If no profile created in 48h → Brevo email: "Need help setting up? Book a quick call with me"]
        ↓
[If profile created → AiSensy WhatsApp: "Profile looks great! Here's how to add your first service"]
        ↓
[7 days later → Brevo email: "Your first week on Familiarise — tips for getting bookings"]
```

**Setup:** Tally.so form → webhook to Brevo + Google Sheets (via Make.com or Zapier free tier)
**Time to build:** 3-4 hours
**Time saved:** 5-10 hours/week on manual onboarding emails

### Workflow 2: Social Media Content Pipeline

**Batch creation (every Sunday, 2 hours):**

1. Open Canva. Create 5 social media posts for the week using templates:
   - **Monday:** Builder update ("We shipped X this week")
   - **Tuesday:** Industry insight (stat, trend, competitor analysis)
   - **Wednesday:** Consultant spotlight (after Month 1)
   - **Thursday:** Feature highlight (demo GIF or screenshot)
   - **Friday:** Question/engagement post ("What's the biggest challenge in...?")

2. Schedule all 5 posts in Buffer for the week

3. Write LinkedIn text for each post (keep in Notion content calendar)

**Templates to create once in Canva:**
- "Did You Know?" stat card (brand colors, clean design)
- Consultant spotlight card (photo + name + expertise + CTA)
- Feature highlight card (screenshot + benefit text)
- Builder update card (logo + short text)
- Comparison card ("TopMate vs Familiarise" side-by-side)

**Time investment:** 2 hours/week (batch) + 30 min/day (engage with comments)
**Time saved vs. ad hoc posting:** 5-8 hours/week

### Workflow 3: Review Collection Automation

**Trigger:** Session marked as completed on the platform

```
[Session completed]
        ↓
[T+1 hour: In-app notification: "How was your session with [Name]? Leave a review"]
        ↓
[T+24 hours: Brevo email: "Your session with [Name] — rate your experience" + review link]
        ↓
[If no review at T+72 hours: AiSensy WhatsApp: "Quick reminder to rate your session with [Name]"]
        ↓
[If review submitted: Brevo email: "Thanks for your review! Here's ₹50 credit for your next session"]
```

**Why this matters:** Reviews are the single most important trust signal. Each review makes it easier to convert the next consultee. Automate collection aggressively.

**Target:** 40-60% of sessions should result in a review (industry average: 15-20%)

### Workflow 4: Cold Outreach Sequences

**For LinkedIn (manual but systematic):**

| Day | Action | Time |
|-----|--------|------|
| Day 0 | Send personalized connection request (300 char) | 2 min each × 10 = 20 min |
| Day 1-3 | Wait for acceptance | — |
| Day 3 | If accepted, send Variation 1 follow-up message | 3 min each |
| Day 7 | If no response, send Variation 2 (feature-focused) | 2 min each |
| Day 14 | Final follow-up or move on | 1 min each |

**For Email (automated with Brevo/Saleshandy):**

| Day | Email | Subject Line |
|-----|-------|-------------|
| Day 0 | Initial cold email | "Your [TopMate profile / expertise] → 6-8% more earnings?" |
| Day 3 | Follow-up #1 | "Quick follow-up: built-in video + UPI payments" |
| Day 7 | Follow-up #2 (value-add) | "[Industry stat or relevant insight] + a question" |
| Day 14 | Break-up email | "Last note — spots filling up for founding members" |

**Setup:** Import email list from Apollo/Snov.io → create sequence in Brevo → set cadence → monitor open/reply rates
**Adjust based on data:** If open rate < 20%, change subject lines. If reply rate < 5%, change body copy.

### Workflow 5: Weekly Reporting

**Automated data pull (via Make.com or manual 15 min):**

```
Every Monday 9 AM:
  → Pull from platform dashboard: new sign-ups, sessions, GMV, active consultants
  → Pull from Google Sheets CRM: outreach sent, responses, demos
  → Pull from Google Analytics: website traffic, sources, top pages
  → Pull from Buffer: social media engagement, follower growth
  → Compile into weekly report template (Google Sheets or Notion)
  → Review in 15 minutes over coffee
```

**Weekly report template:**

```
WEEK OF [DATE]
────────────────────────────────
SALES PIPELINE
  Outreach sent:        __/50 (target)
  Responses:            __/12
  Demo calls:           __/5
  New sign-ups:         __/2
  New active:           __/1

PLATFORM METRICS
  Total consultants:    __
  Active consultants:   __
  Sessions this week:   __
  GMV this week:        ₹__
  Reviews collected:    __

MARKETING
  LinkedIn followers:   __  (+__ this week)
  Website visits:       __
  Top traffic source:   __
  Best performing post: __

ACTIONS FOR NEXT WEEK
  1. __
  2. __
  3. __
────────────────────────────────
```

---

## Chapter 4: The "One Person Marketing Machine" Blueprint

### Daily Routine (2 hours, 5 days/week)

| Time | Activity | Duration |
|------|----------|----------|
| 9:00 AM | Check and respond to all messages (LinkedIn, email, WhatsApp) | 30 min |
| 9:30 AM | Send 10 new outreach messages (LinkedIn/email) | 30 min |
| 10:00 AM | Create/schedule 1 social media post OR engage with 10 posts (alternating days) | 30 min |
| 10:30 AM | Pipeline management: follow up on pending leads, update CRM, send demo reminders | 30 min |

**Total daily marketing time: 2 hours. Non-negotiable. Block this in your calendar.**

### Weekly Routine

| Day | Extra Activity | Duration |
|-----|---------------|----------|
| Sunday | Batch create 5 social media posts for the week in Canva + Buffer | 2 hours |
| Monday | Review weekly metrics, plan outreach targets, prioritize pipeline | 1 hour |
| Wednesday | Write one blog post or LinkedIn article (SEO content) | 1.5 hours |
| Friday | Engage in 2-3 community discussions (Reddit, Twitter threads, LinkedIn groups) | 1 hour |

### Monthly Routine

| Week | Activity | Duration |
|------|----------|----------|
| Week 1 | Review all channel metrics, reallocate time to what's working | 2 hours |
| Week 2 | Host or co-host 1 free webinar (use the platform's own webinar feature) | 2 hours prep + 1 hour live |
| Week 3 | Audit and update all outreach templates based on response data | 1.5 hours |
| Week 4 | Write monthly recap post for LinkedIn ("Month [X] building Familiarise: lessons learned") | 1 hour |

---

## Chapter 5: WhatsApp Business API Strategy

### Why WhatsApp Is Non-Negotiable for India

| Channel | Open Rate | Click Rate | Cost per Message |
|---------|-----------|-----------|------------------|
| Email | 15-25% | 2-5% | ~₹0.05 |
| Push notification | 20-30% | 5-10% | ₹0 |
| **WhatsApp** | **98%** | **45-50%** | **₹0.50-1.50** |
| SMS | 95% | 10-15% | ₹0.10-0.25 |

WhatsApp is 5-10x more effective than email for Indian users. Not using it is leaving money on the table.

### Provider Recommendation: AiSensy

| Feature | AiSensy | Wati | Interakt |
|---------|---------|------|----------|
| Starting price | ₹999/month | ₹2,499/month | ₹999/month |
| Free trial | 14 days | 7 days | 14 days |
| API access | Yes | Yes | Yes |
| Broadcast limit | Unlimited | 25K/month | Unlimited |
| Chatbot builder | Yes | Yes | Basic |
| Indian support | Yes (Delhi-based) | Yes | Yes |

**Recommendation:** Start with AiSensy at ₹999-1,500/month.

### WhatsApp Use Cases (Priority Order)

| Priority | Use Case | Template Message | When to Send |
|----------|----------|-----------------|-------------|
| 1 | **Booking confirmation** | "Your session with [Consultant] is confirmed for [Date] at [Time]. Join here: [Link]" | Immediately after booking |
| 2 | **Session reminder** | "Reminder: Your session with [Consultant] starts in 1 hour. Join: [Link]" | T-1 hour |
| 3 | **Review request** | "How was your session with [Consultant]? Rate in 30 seconds: [Link]" | T+24 hours |
| 4 | **Consultant welcome** | "Welcome to Familiarise! Set up your profile in 5 minutes: [Link]. Questions? Reply here." | On sign-up |
| 5 | **Promotional broadcast** | "New webinar: [Topic] with [Consultant]. [Date] at [Time]. Free. Register: [Link]" | 3 days before webinar |

### WhatsApp Template Approval

WhatsApp Business API requires template message approval (24-48 hours). Prepare and submit all 5 templates above before launch.

---

## Chapter 6: Digitization Tools — India-Specific

### Business Operations

| Function | Tool | Cost | Why This One |
|----------|------|------|-------------|
| **GST Invoicing** | Refrens.com | Free (basic) / ₹199/mo | India-native, auto-GST calculation, professional templates |
| **Accounting** | Zoho Books | Free (₹20L revenue limit) | GST filing, TDS, Indian tax compliance built-in |
| **Company registration** | Vakilsearch | One-time ₹6-15K | End-to-end: Sole Proprietorship registration, GST, PAN |
| **Business banking** | Razorpay X | Free (basic) | Links to existing Razorpay, auto-payouts to consultants |
| **Contracts** | Stamp (stamp.legal) | ₹500/contract | India-legal e-signatures, stamp duty calculation |

### Communication

| Function | Tool | Cost | Why |
|----------|------|------|-----|
| **Team chat** | Slack (free) or Discord | ₹0 | Internal team communication (you + dev) |
| **Consultant support** | WhatsApp Business | ₹0 (manual) / ₹1,500 (API) | India's default. They WILL message you on WhatsApp. |
| **Website live chat** | Tawk.to | ₹0 | Catch website visitors, answer questions in real-time |
| **Email** | Gmail (Google Workspace) | ₹0 (personal) / ₹136/mo (business email) | @familiarise.com email for professional outreach |

### SEO & Analytics

| Function | Tool | Cost | Why |
|----------|------|------|-----|
| **Keyword tracking** | Google Search Console | ₹0 | Track which keywords your profiles rank for |
| **Website analytics** | Google Analytics 4 | ₹0 | Traffic sources, user behavior, conversion tracking |
| **Heatmaps** | Microsoft Clarity | ₹0 | See where users click, scroll, drop off |
| **Uptime monitoring** | BetterStack (free) | ₹0 | Status page + uptime alerts |
| **Error tracking** | Sentry (free) | ₹0 (5K events/month) | Catch platform errors before users report them |

---

## Chapter 7: Content Automation

### Blog Post Assembly Line

You don't need to be a content writer. You need a system.

**Step 1: Find topics (10 min)**
- Google Search Console: which keywords are getting impressions but low clicks? Write about those.
- r/developersIndia, r/IndiaInvestments: what questions are people asking?
- TopMate creator profiles: what services are popular? Write about those topics.
- AnswerThePublic.com: free tool that shows questions people search about a topic.

**Step 2: Draft with AI (20 min)**
- Use Claude to draft the post from an outline
- Your outline should include: title, 3-5 key points, target keyword, CTA
- Edit for voice and accuracy (the draft is a starting point, not final)

**Step 3: Optimize for SEO (10 min)**
- Include target keyword in title, first paragraph, and 2-3 subheadings
- Add internal links to relevant consultant profiles on the platform
- Add meta description (150-160 characters)
- Include at least one image (Canva graphic or screenshot)

**Step 4: Publish and distribute (10 min)**
- Publish on platform blog
- Share on LinkedIn with a hook + summary
- Post on Twitter with key takeaway
- Share in relevant Reddit/Discord communities (if genuinely useful, not spammy)

**Target: 1 blog post per week. 50 minutes total.**

### Social Media Content Templates

Create these once in Canva, reuse weekly:

**Template 1: Stat Card**
```
┌─────────────────────────┐
│   [BRAND LOGO]          │
│                         │
│   [BIG NUMBER]          │
│   [What it means]       │
│                         │
│   Source: [Source]       │
│   familiarise.com       │
└─────────────────────────┘
```
Use for: Market data, competitor stats, platform milestones

**Template 2: Comparison**
```
┌─────────────────────────┐
│ TopMate    vs  Familiarise │
│ Zoom links    Built-in HD  │
│ 16-18% fee    10% flat     │
│ No UPI        UPI native   │
│ 1-2 types     4 types      │
│                            │
│ familiarise.com            │
└────────────────────────────┘
```
Use for: Competitive positioning (use sparingly, don't attack — inform)

**Template 3: Consultant Spotlight**
```
┌─────────────────────────┐
│   [PHOTO]               │
│   [Name]                │
│   [Title/Expertise]     │
│   [Quote from them]     │
│                         │
│   Book a session →      │
│   familiarise.com/[slug]│
└─────────────────────────┘
```
Use for: Social proof, consultant promotion

---

## Chapter 8: What NOT to Automate

Some things must remain human, especially at your stage.

### Never Automate:

1. **Demo calls** — Founder-led for first 50 consultants. Always.
2. **First response to interested creators** — If someone replies "I'm interested," the first response MUST be personal, not a template.
3. **Crisis communication** — If the platform goes down or a payment fails, you respond personally. Not a chatbot.
4. **Consultant feedback calls** — Monthly calls with top consultants to understand pain points. No survey replaces a conversation.
5. **Pricing decisions** — Never let automation adjust pricing. Manual review always.
6. **Anything involving money disputes** — Refunds, payout issues, commission questions. Always personal.

### The Automation Trap

Don't spend 20 hours building an automation that saves 1 hour/week. The math doesn't work until Month 6+.

**Rule of thumb:** If a manual process takes <30 minutes/week, do it manually. Automate only when it crosses 2 hours/week OR when error risk from manual handling is high (e.g., forgetting to send session reminders).

---

## Chapter 9: Scaling the Stack

### Month 1-3 Total Stack Cost: ₹0-1,500/month

| Tool | Cost |
|------|------|
| Google Suite (Sheets, Calendar, Docs) | ₹0 |
| Canva free | ₹0 |
| Buffer free | ₹0 |
| Tally.so | ₹0 |
| Tawk.to | ₹0 |
| GA4 + Search Console + Clarity | ₹0 |
| AiSensy (Month 2+) | ₹1,500 |
| **Total** | **₹0-1,500** |

### Month 4-6 Total Stack Cost: ₹3,500-5,000/month

Add: Snov.io (₹3,300), Make.com (₹760), Brevo starter (₹750)

### Month 7-12 Total Stack Cost: ₹5,000-8,000/month

Add: Apollo.io (₹4,200), Zoho CRM (₹0 free tier)

### When to Hire a Marketing Person

**Not yet.** Don't hire for marketing until:
- You have 100+ active consultants (proven supply)
- You have ₹2L+/month commission revenue (can afford ₹15-25K salary)
- You've personally figured out which channels work (you can't manage what you don't understand)
- Usually: Month 6-9

**First marketing hire profile:**
- Social media manager + community manager hybrid
- Fluent in LinkedIn and Twitter content
- ₹15-25K/month (full-time) or ₹8-12K (part-time)
- Handles: social media posting, community engagement, blog editing, review collection
- Does NOT handle: sales outreach (that stays with founder or sales hire)
