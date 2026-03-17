# Research: Scheduling Infrastructure Alternatives

> Migrated from GitHub Issue #373 (2026-01-23). This is a research document evaluating external scheduling APIs as potential replacements or supplements to the custom booking system.

---

## Problem Statement

The current custom slot booking system has several concerns:

1. **Maintenance Burden**: Complex time slot processing logic (`utils/timeSlotsProcessing.ts`) with edge cases for overnight slots, timezone handling, and overlap calculations
2. **Reliability Concerns**: Recent bugs like COMPLETED events blocking availability, data corruption filters needed, defensive programming required throughout
3. **Scalability**: Need to handle real-time availability for millions of users simultaneously
4. **Accuracy**: Coverage percentage calculations, slot merging, and booking status determination are error-prone

**Current Implementation Files:**
- `utils/timeSlotsProcessing.ts` - Core availability processing logic (~400 lines)
- `app/api/slots/availability-with-allocation/[consultantId]/route.ts` - API endpoint with defensive filters
- Multiple components consuming slot data

---

## Alternative Solutions Comparison

### 1. Cronofy - Calendar Infrastructure API

**Best for**: Enterprise-grade scheduling with calendar sync and compliance requirements

| Aspect | Details |
|--------|---------|
| **Pricing** | Starting €749/month (API), €14/user/month (Scheduler) |
| **Rate Limits** | 50/sec, 500/min - stable at scale |
| **Compliance** | GDPR, HIPAA, SOC 2, ISO certified on ALL plans |
| **Uptime** | 99.99% SLA guaranteed |
| **Calendar Sync** | Google, Microsoft, Apple, Exchange via single API |

**Key Features:**
- Availability API handles multi-participant, round-robin, multi-timezone scheduling in ONE call
- Cross-domain availability (no domain restrictions like Nylas)
- Caches availability internally - stable even when external providers fail
- Smart Invites for meeting coordination
- Embedded Scheduler UI components

**Pros:**
- Specialized in scheduling since 2014
- Enterprise-grade reliability and compliance
- Single API call for complex availability queries

**Cons:**
- Higher starting price (€749/month)
- Scheduler sold separately from Calendar API

**Links:** [Cronofy Developer](https://www.cronofy.com/developer)

---

### 2. Nylas - Unified Communication API

**Best for**: Apps needing email + calendar + contacts integration

| Aspect | Details |
|--------|---------|
| **Pricing** | $0.90/connected account/month |
| **Rate Limits** | 500 requests/second (higher than Cronofy) |
| **APIs Included** | Calendar, Email, Contacts, Scheduler |
| **Compliance** | Varies by plan |

**Key Features:**
- Unified API for calendar, email, and contacts
- Scheduler included in pricing (no separate cost)
- No overage fees or usage limits
- Pre-built UI components

**Pros:**
- Lower per-account pricing
- All-in-one communication API
- More configurable for custom UX

**Cons:**
- Domain restrictions (v3 API limits cross-organization queries)
- Users connect to shared Google project (not your own)
- Not pure scheduling focus

**Links:** [Nylas Scheduler](https://www.nylas.com/solutions/scheduling-automation/)

---

### 3. OnSched - Healthcare-Grade Scheduling API

**Best for**: HIPAA compliance, healthcare, high-stakes scheduling

| Aspect | Details |
|--------|---------|
| **Pricing** | Starting $299/month, pay per appointment |
| **Compliance** | HIPAA, SOC 2, GDPR, PIPEDA |
| **White-label** | Full white-labeling, single API key |
| **Proven Scale** | Handled 80% of Canada's COVID-19 vaccine scheduling |

**Key Features:**
- Usage-based pricing (only pay for bookings)
- Multi-location, multi-resource scheduling
- Full API documentation + OnSched.js SDK
- Webhooks, CRM/EMR integration

**Pros:**
- Healthcare-proven reliability
- Flexible pricing model
- 30-day typical integration time

**Cons:**
- Not open-source
- Less focus on calendar sync

**Links:** [OnSched](https://www.onsched.com/)

---

### 4. Cal.com - Open Scheduling Infrastructure (Recommended)

**Best for**: Full control, self-hosting, cost-effective at scale

| Aspect | Details |
|--------|---------|
| **Pricing** | FREE (self-host), $12-189/user/month (cloud) |
| **Platform API** | $189/month + $0.05/booking |
| **Open Source** | Yes, full source code available |
| **White-label** | Full white-labeling on Platform plan |

**Plans Breakdown:**
- **Free (Self-hosted)**: Unlimited, no per-seat costs
- **Teams**: $12/user/month - team scheduling features
- **Platform**: $189/month - SDK, embeds, white-label

**Key Features:**
- React SDK and embeddable components
- Full API access (unlimited on self-host)
- Video conferencing integrations (Zoom, Google Meet, etc.)
- Webhook privacy and customization
- Active open-source community

**Pros:**
- No vendor lock-in (open-source)
- Self-hosting eliminates per-seat costs at scale
- Full customization possible
- Start cloud, migrate to self-host when ready

**Cons:**
- Self-hosting requires DevOps expertise
- Platform API tier needed for embedding

**Links:** [Cal.com](https://cal.com), [GitHub](https://github.com/calcom/cal.com)

---

### 5. Timekit - Marketplace Scheduling

**Best for**: Marketplaces, on-demand apps, simpler use cases

| Aspect | Details |
|--------|---------|
| **Pricing** | Starting $49/month (14-day trial) |
| **SDK** | booking.js (MIT license, open-source) |
| **Infrastructure** | Google Cloud Platform |

**Key Features:**
- Unified API for booking infrastructure
- booking.js embeddable widget
- Zapier, Stripe, Braintree integrations
- Team scheduling, multi-resource

**Pros:**
- Lower starting price
- Good for marketplaces
- Open-source booking.js widget

**Cons:**
- Less enterprise features
- Smaller community than Cal.com

**Links:** [Timekit](https://www.timekit.io/)

---

### 6. meetergo - Headless Scheduling Engine

**Best for**: AI voice agents, German-hosted privacy, custom SaaS

| Aspect | Details |
|--------|---------|
| **Architecture** | Headless (API-only, no forced UI) |
| **Hosting** | 100% German-hosted |
| **Identity** | SCIM 2.0 support (Azure AD, Okta) |
| **Webhooks** | Mission-critical, instant delivery |

**Key Features:**
- Raw availability logic via API
- No UI structure forced on developers
- Low-latency scheduling
- Privacy-first design

**Pros:**
- True headless architecture
- EU data residency
- Enterprise identity management

**Cons:**
- Less documentation available
- Smaller market presence

**Links:** [meetergo](https://meetergo.com/)

---

## Recommendation Matrix

| Solution | Cost | Scalability | Reliability | Customization | Self-Host |
|----------|------|-------------|-------------|---------------|-----------|
| **Cal.com** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ✅ |
| **Cronofy** | ⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ❌ |
| **OnSched** | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ❌ |
| **Nylas** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ❌ |
| **Timekit** | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | ❌ |
| **meetergo** | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ❌ |

---

## Top Recommendations by Use Case

### For Full Control + Cost Efficiency: **Cal.com (Self-Hosted)**
- Free, open-source
- Start with cloud, migrate to self-host
- React SDK for embedding
- Active community

### For Enterprise Reliability + Compliance: **Cronofy**
- 99.99% uptime SLA
- HIPAA/GDPR/SOC2 on all plans
- Best availability API

### For Healthcare/High-Stakes: **OnSched**
- Proven at massive scale (COVID vaccines)
- HIPAA compliant
- Pay-per-booking model

### For Budget + Quick Start: **Timekit**
- $49/month starting
- Good documentation
- Marketplace-focused

---

## Next Steps

1. **Evaluate Cal.com first** - spin up a local instance and test the API
2. **Request demos** from Cronofy and OnSched for enterprise pricing
3. **Prototype integration** with Cal.com Platform API to see embedding experience
4. **Decision matrix**: Create weighted scoring based on your specific requirements

---

## Sources

- [Cronofy Developer](https://www.cronofy.com/developer)
- [Nylas Scheduling](https://www.nylas.com/solutions/scheduling-automation/)
- [OnSched](https://www.onsched.com/)
- [Cal.com](https://cal.com)
- [Cal.com GitHub](https://github.com/calcom/cal.com)
- [Timekit](https://www.timekit.io/)
- [meetergo](https://meetergo.com/en/magazine/cal-com-api)
- [Cal.com Pricing](https://cal.com/pricing)
- [Cronofy vs Nylas](https://www.cronofy.com/nylas-alternative)
- [OnSched Healthcare](https://www.onsched.com/use-cases/healthcare)
