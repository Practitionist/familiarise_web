# The Modern Software Abstraction Pyramid

> Every software company is building on top of every other software company.

## The Pyramid

```mermaid
graph TB
    subgraph L5["LAYER 5: APPLICATION"]
        APP["Your App (Familiarise)"]
    end

    subgraph L4["LAYER 4: COMPOSITION"]
        NOVU[Novu]
        STRIPE[Stripe]
        STREAM[Stream]
        RESEND[Resend]
        ALGOLIA[Algolia]
        TWILIO[Twilio]
    end

    subgraph L3["LAYER 3: PLATFORM"]
        SUPABASE[Supabase]
        VERCEL[Vercel]
        PLANETSCALE[PlanetScale]
        CLOUDFLARE[Cloudflare]
        RAILWAY[Railway]
    end

    subgraph L2["LAYER 2: INFRASTRUCTURE"]
        AWS[AWS]
        GCP[GCP]
        AZURE[Azure]
        DO[DigitalOcean]
    end

    subgraph L1["LAYER 1: FOUNDATION"]
        LINUX[Linux]
        TCP[TCP/IP]
        HTTP[HTTP]
        TLS[TLS]
        K8S[Kubernetes]
    end

    APP --> NOVU & STRIPE & STREAM & RESEND
    NOVU & STRIPE & STREAM & RESEND --> SUPABASE & VERCEL
    SUPABASE & VERCEL --> AWS & GCP
    AWS & GCP --> LINUX & TCP & HTTP
```

---

## The 5 Layers Explained

### Layer 1: Foundation (Protocols & Standards)

**What:** The bedrock that everything runs on
**Who builds:** Open source communities, standards bodies, core infrastructure companies

| Category           | Examples                        |
| ------------------ | ------------------------------- |
| Operating Systems  | Linux, Windows Server           |
| Protocols          | TCP/IP, HTTP/2, gRPC, WebSocket |
| Security           | TLS, OAuth, JWT                 |
| Containerization   | Docker, Kubernetes, containerd  |
| Languages/Runtimes | V8, Node.js, JVM, BEAM          |

**Business model:** Mostly open source, some enterprise support (Red Hat, Docker Inc)

---

### Layer 2: Infrastructure (Compute & Storage)

**What:** Raw computing resources abstracted from hardware
**Who builds:** Cloud giants with massive capital

| Category        | Examples                        |
| --------------- | ------------------------------- |
| Compute         | AWS EC2, GCP Compute, Azure VMs |
| Storage         | S3, GCS, Azure Blob             |
| Networking      | VPCs, Load Balancers, CDNs      |
| Databases (raw) | RDS, Cloud SQL, DynamoDB        |

**Business model:** Pay-per-use, volume discounts
**Margins:** 30-60%

---

### Layer 3: Platform (Developer Experience)

**What:** Infrastructure wrapped with better DX
**Who builds:** Companies that abstract away DevOps complexity

| Category             | Examples                 | Built On  |
| -------------------- | ------------------------ | --------- |
| Backend-as-a-Service | Supabase, Firebase       | AWS/GCP   |
| Deployment           | Vercel, Netlify, Railway | AWS/GCP   |
| Databases            | PlanetScale, Neon, Turso | AWS/GCP   |
| Edge/CDN             | Cloudflare, Fastly       | Own infra |
| Serverless           | AWS Lambda, CF Workers   | Own infra |

**Business model:** Freemium + usage-based
**Margins:** 50-70%

---

### Layer 4: Composition (Specialized Services)

**What:** Single-purpose APIs that solve one problem extremely well
**Who builds:** Vertical specialists

| Category      | Examples               | Built On         |
| ------------- | ---------------------- | ---------------- |
| Payments      | Stripe, Razorpay       | AWS + banks      |
| Notifications | Novu, Knock, OneSignal | AWS + FCM/APNS   |
| Email         | Resend, SendGrid       | AWS + SMTP infra |
| Auth          | Auth0, Clerk, WorkOS   | AWS              |
| Search        | Algolia, Typesense     | AWS              |
| Video/Chat    | Stream, Twilio, Agora  | AWS + WebRTC     |
| Analytics     | Mixpanel, Amplitude    | AWS/GCP          |
| CMS           | Sanity, Contentful     | AWS              |
| AI/ML         | OpenAI, Anthropic      | Azure/GCP        |

**Business model:** API calls / seats / usage
**Margins:** 60-80%

---

### Layer 5: Application (Your Product)

**What:** End-user applications that solve real-world problems
**Who builds:** You, startups, enterprises

| Category     | Examples              | Built On                     |
| ------------ | --------------------- | ---------------------------- |
| Marketplaces | Airbnb, Uber          | Stripe + Maps + Twilio + AWS |
| SaaS         | Notion, Figma, Slack  | AWS + various APIs           |
| EdTech       | Familiarise, Coursera | Supabase + Stream + Novu     |
| Fintech      | Robinhood, Plaid      | AWS + banking APIs           |
| E-commerce   | Shopify stores        | Shopify + Stripe             |

**Business model:** Subscriptions, transactions, ads
**Margins:** Varies (20-90%)

---

## The Value Chain

```mermaid
flowchart LR
    subgraph Foundation
        OS[Linux/Open Source]
    end

    subgraph Infrastructure
        CLOUD[AWS/GCP/Azure]
    end

    subgraph Platform
        PLAT[Vercel/Supabase]
    end

    subgraph Composition
        COMP[Stripe/Novu/Stream]
    end

    subgraph Application
        YOU[Your App]
    end

    OS -->|"$0 (free)"| CLOUD
    CLOUD -->|"$80B/yr revenue"| PLAT
    PLAT -->|"$100M+/yr revenue"| COMP
    COMP -->|"$14B+/yr revenue"| YOU
    YOU -->|"~$230/mo"| COMP
```

---

## Build vs Buy at Each Layer

| Layer          | Build Cost           | Buy Cost           | Winner    |
| -------------- | -------------------- | ------------------ | --------- |
| Foundation     | Impossible           | Free (open source) | Buy       |
| Infrastructure | $100M+ data centers  | ~$0.01/hour        | Buy       |
| Platform       | $500K/yr DevOps team | ~$20-100/month     | Buy       |
| Composition    | $10K-50K per feature | ~$30-200/month     | Buy       |
| Application    | **YOUR CORE VALUE**  | N/A                | **BUILD** |

> **Rule of thumb:** Only build what differentiates you. Buy everything else.

---

## Familiarise's Position in the Pyramid

```mermaid
graph TB
    subgraph "YOUR CODE (Layer 5)"
        A1[Consultant marketplace logic]
        A2[Booking/scheduling system]
        A3[Payment flow orchestration]
        A4[User experience]
    end

    subgraph "COMPOSITION (Layer 4) - ~$175/mo"
        B1["Novu ($30/mo) - Notifications"]
        B2["Stream ($99/mo) - Video/Chat"]
        B3["Stripe (2.9%) - Payments"]
        B4["Resend ($20/mo) - Email"]
        B5["Sentry ($26/mo) - Errors"]
    end

    subgraph "PLATFORM (Layer 3) - ~$55/mo"
        C1["Supabase ($25/mo) - DB/Auth/Storage"]
        C2["Vercel ($20/mo) - Hosting"]
        C3["Upstash ($10/mo) - Redis/Cron"]
    end

    subgraph "INFRASTRUCTURE (Layer 2)"
        D1[AWS - paid by Supabase/Vercel]
    end

    subgraph "FOUNDATION (Layer 1)"
        E1[Linux, Node.js, PostgreSQL, HTTP, TLS]
    end

    A1 & A2 & A3 & A4 --> B1 & B2 & B3 & B4 & B5
    B1 & B2 & B3 & B4 & B5 --> C1 & C2 & C3
    C1 & C2 & C3 --> D1
    D1 --> E1
```

**Your Total:** ~$230/month
**Equivalent Build Cost:** ~$15,000/month

---

## Industry Names for These Layers

| Layer   | Common Names                                                 |
| ------- | ------------------------------------------------------------ |
| Layer 5 | Application Layer, Product Layer, Solution Layer             |
| Layer 4 | Composition Layer, API Layer, Service Layer, "Best-of-Breed" |
| Layer 3 | Platform Layer, PaaS, Developer Platform, "Modern Stack"     |
| Layer 2 | Infrastructure Layer, IaaS, Cloud Layer                      |
| Layer 1 | Foundation Layer, Protocol Layer, Standards Layer            |

---

## The Trend: Layers Keep Adding

```mermaid
timeline
    title Evolution of Software Architecture
    2000s : Bare Metal
          : [Your Code] → [Linux] → [Hardware]
    2010s : Cloud Era
          : [Your Code] → [AWS] → [Linux]
    2015s : Platform Era
          : [Your Code] → [Heroku] → [AWS]
    2020s : Composition Era
          : [Your Code] → [Stripe+Novu] → [Vercel] → [AWS]
    2025+ : AI Era
          : [Your Code] → [AI Agents] → [Composition] → [Platforms]
```

**Each new layer = more abstraction = faster development = focus on your unique value**

---

## Key Insight

> Your job is NOT to rebuild the wheel.
> Your job IS to combine existing wheels into a vehicle nobody has built before.

- Stripe didn't build AWS. They used it.
- Vercel didn't build Linux. They used it.
- Familiarise didn't build payments. You used Stripe.

**The winners are those who pick the right tools and focus on their unique value.**

---

_Created: January 2026_
_Context: Novu Integration Planning_
