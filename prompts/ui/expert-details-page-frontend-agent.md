# Front-End Agent Prompt: Expert Details Page — Complete Rebuild

## Context

You are building the **Expert Details page** for **Familiarise**, an expert services marketplace ("Shopify for Knowledge Businesses"). This is the most critical conversion page on the platform — a consultee lands here after discovering an expert, and must be able to understand the expert's value proposition and initiate a booking within seconds.

**Tech stack:**

- Next.js 15 (App Router, RSC-first)
- React 18 + TailwindCSS + Radix UI primitives
- TypeScript (strict)
- Prisma 7.3 + PostgreSQL (data is server-fetched)
- BetterAuth (session-aware, user may or may not be logged in)

**Route:** `/explore/experts/[consultantId]`

The current implementation is fragmented and needs to be rebuilt from scratch with a coherent layout, better visual hierarchy, and a conversion-optimised architecture. **Do not reference or preserve any existing component files.** You are free to design the component tree, naming conventions, file structure, and layout architecture from first principles.

---

## Scope Boundaries

- **Do NOT** build any payment gateway integration or checkout flow — those are handled by a separate checkout route.
- **Do NOT** build any toast/notification/alert UI components — none exist in the design system and none are needed here.
- **Do NOT** implement the internal mechanics of the pricing toggle (e.g., monthly/annual switching logic) — simply render the plans as-is.
- **Do NOT** build auth flows — assume you can read the current session via a `useSession()` hook or server-side session utility.
- **DO** implement deep-link anchor navigation between sections (e.g., `#services`, `#reviews`, `#about`).

---

## Prisma Schema Reference

Below are the relevant database models. Use these to understand the exact shape of data your components will receive. **Ignore all booking/appointment/payment models** — they are write-side only.

### Core Identity

```prisma
model User {
  id                   String    @id
  name                 String
  image                String?
  profileDisplayImage  String?          // Square crop for cards/profile
  bio                  String?   @db.VarChar(160)   // Short tagline
  city                 String?
  country              String?
  linkedinUrl          String?
  timezone             String?
  role                 UserRole?
  workExperiences      WorkExperience[]
  certifications       Certification[]
  education            Education[]
  consultantProfile    ConsultantProfile?
}

model ConsultantProfile {
  id                          String   @id
  headline                    String?  @db.VarChar(120)   // Professional headline
  description                 String?  @db.Text           // Long-form about/bio
  experience                  Float?                      // Years of experience
  rating                      Float    @default(0)
  totalMenteesHelped          Int      @default(0)
  isVerified                  Boolean  @default(false)
  verificationStatus          ConsultantVerificationStatus
  languages                   String[]
  toolsAndTechnologies        String[]
  mentoringStyle              String?  @db.Text
  sessionTypes                SessionType[]
  websiteUrl                  String?
  twitterUrl                  String?
  githubUrl                   String?
  videoIntroUrl               String?
  scheduleType                ScheduleType

  // Relations
  user                        User
  domain                      Domain
  subDomains                  SubDomain[]
  tags                        Tag[]
  reviews                     ConsultantReview[]
  slotsOfAvailabilityWeekly   SlotOfAvailabilityWeekly[]
  slotsOfAvailabilityCustom   SlotOfAvailabilityCustom[]
  consultationPlans           ConsultationPlan[]
  subscriptionPlans           SubscriptionPlan[]
  webinarPlans                WebinarPlan[]
  classPlans                  ClassPlan[]
}
```

### Taxonomy

```prisma
model Domain {
  id   String @id
  name String @unique
}

model SubDomain {
  id       String @id
  name     String
  domainId String
}

model Tag {
  id       String @id
  name     String
  domainId String
}
```

### Professional Background

```prisma
model WorkExperience {
  id          String
  company     String
  title       String
  location    String?
  startDate   DateTime
  endDate     DateTime?
  isCurrent   Boolean
  description String?  @db.Text
  userId      String
}

model Education {
  id           String
  institution  String
  degree       String
  fieldOfStudy String?
  startYear    Int?
  endYear      Int?
  grade        String?
  description  String?  @db.Text
  userId       String
}

model Certification {
  id                  String
  name                String
  issuingOrganization String
  issueDate           DateTime
  expiryDate          DateTime?
  credentialId        String?
  credentialUrl       String?
  userId              String
}
```

### Services & Plans

```prisma
// 1-on-1 sessions
model ConsultationPlan {
  id               String
  title            String
  description      String?  @db.Text
  durationInHours  Float
  price            Int             // In minor currency units (paise/cents)
  priceCurrency    String          // "INR", "USD"
  language         String
  level            String          // "Beginner", "Intermediate", "Advanced"
  prerequisites    String?
  materialProvided String?
  learningOutcomes String[]
  topics           Topic[]
  materials        PlanMaterial[]
  consultantProfileId String
}

// Recurring mentorship subscriptions
model SubscriptionPlan {
  id                     String
  title                  String
  description            String?  @db.Text
  durationInMonths       Int
  price                  Int
  priceCurrency          String
  callsPerWeek           Int
  sessionDurationInHours Float
  totalSessions          Int
  totalHours             Float
  emailSupport           PlanEmailSupport    // GENERAL | PRIORITY | NONE
  language               String
  level                  String
  prerequisites          String?
  materialProvided       String?
  learningOutcomes       String[]
  topics                 Topic[]
  freeTrialEnabled       Boolean
  freeTrialDurationMinutes Int
  subscriptionContents   SubscriptionContent[]
  materials              PlanMaterial[]
  consultantProfileId    String
}

// One-time live group sessions
model WebinarPlan {
  id                  String
  title               String
  description         String?  @db.Text
  price               Int
  priceCurrency       String
  durationInHours     Float
  maxParticipants     Int
  language            String?
  level               String?
  prerequisites       String?
  materialProvided    String?
  learningOutcomes    String[]
  certificateProvided Boolean
  recordingEnabled    Boolean
  imageUrl            String?
  topics              Topic[]
  materials           PlanMaterial[]
  webinars            Webinar[]       // Scheduled instances
  consultantProfileId String?
}

// Multi-session cohort programs
model ClassPlan {
  id                     String
  title                  String
  description            String   @db.Text
  price                  Int
  priceCurrency          String
  durationInMonths       Int
  meetingsPerWeek        Int
  sessionDurationInHours Float
  totalSessions          Int
  totalHours             Float
  maxParticipants        Int
  emailSupport           PlanEmailSupport
  language               String?
  level                  String?
  prerequisites          String?
  materialProvided       String?
  learningOutcomes       String[]
  certificateProvided    Boolean
  recordingEnabled       Boolean
  imageUrl               String?
  topics                 Topic[]
  classContents          ClassContent[]
  materials              PlanMaterial[]
  classes                Class[]        // Scheduled cohort instances
  consultantProfileId    String?
}
```

### Availability

```prisma
// Recurring weekly availability windows
model SlotOfAvailabilityWeekly {
  id           String
  startDay     DayOfWeek   // MON | TUE | WED | THU | FRI | SAT | SUN
  startTimeUtc Int @db.SmallInt   // Minutes since midnight UTC (0–1439)
  endDay       DayOfWeek
  endTimeUtc   Int @db.SmallInt
  consultantProfileId String
}

// One-off custom availability windows
model SlotOfAvailabilityCustom {
  id       String
  startsAt DateTime @db.Timestamptz
  endsAt   DateTime @db.Timestamptz
  consultantProfileId String
}
```

### Reviews

```prisma
model ConsultantReview {
  id                  String
  rating              Int @db.SmallInt   // 1–5
  reviewDescription   String?  @db.Text
  consultantProfileId String
  consulteeProfile    ConsulteeProfile   // Reviewer info
  createdAt           DateTime
}

// From ConsulteeProfile → User:
// reviewer name: consulteeProfile.user.name
// reviewer avatar: consulteeProfile.user.image
```

### Supporting Types

```prisma
model Topic {
  id   String
  name String
}

model PlanMaterial {
  id    String
  title String
  url   String
  type  MaterialType   // PDF | VIDEO | LINK | DOCUMENT
}

model SubscriptionContent {
  id          String
  title       String
  description String?
}

model ClassContent {
  id          String
  title       String
  description String?
}

// Scheduled instances of WebinarPlan
model Webinar {
  id          String
  startsAt    DateTime
  endsAt      DateTime
  status      WebinarStatus
  webinarPlan WebinarPlan
}

// Scheduled cohort instances of ClassPlan
model Class {
  id        String
  startsAt  DateTime
  endsAt    DateTime
  status    ClassStatus
  classPlan ClassPlan
}
```

---

## Page Data Contract

The page receives one consolidated server-side payload of type `TConsultantDetailData`:

```typescript
type TConsultantDetailData = {
  id: string;
  headline: string | null;
  description: string | null;
  experience: number | null;
  rating: number;
  totalMenteesHelped: number;
  isVerified: boolean;
  languages: string[];
  toolsAndTechnologies: string[];
  mentoringStyle: string | null;
  sessionTypes: SessionType[];
  websiteUrl: string | null;
  twitterUrl: string | null;
  githubUrl: string | null;
  videoIntroUrl: string | null;
  scheduleType: ScheduleType;

  user: {
    id: string;
    name: string;
    image: string | null;
    profileDisplayImage: string | null;
    bio: string | null;
    city: string | null;
    country: string | null;
    linkedinUrl: string | null;
    timezone: string | null;
    workExperiences: WorkExperience[];
    education: Education[];
    certifications: Certification[];
  };

  domain: Domain;
  subDomains: SubDomain[];
  tags: Tag[];

  slotsOfAvailabilityWeekly: SlotOfAvailabilityWeekly[];
  slotsOfAvailabilityCustom: SlotOfAvailabilityCustom[];

  consultationPlans: ConsultationPlan[];
  subscriptionPlans: (SubscriptionPlan & {
    subscriptionContents: SubscriptionContent[];
  })[];
  webinarPlans: (WebinarPlan & { webinars: Webinar[] })[];
  classPlans: (ClassPlan & {
    classes: Class[];
    classContents: ClassContent[];
  })[];
};

type TConsultantReview = {
  id: string;
  rating: number;
  reviewDescription: string | null;
  createdAt: Date;
  consulteeProfile: {
    user: { name: string; image: string | null };
  };
};
```

Reviews are fetched separately (potentially paginated) and passed alongside the main payload.

---

## Page Sections — What Must Be Present

Design and implement the following sections. The **order, visual weight, and layout** of these sections is for you to engineer — prioritise conversion and scannability. You are not constrained to a vertical stack; consider split layouts, sticky elements, tabs, and scroll-linked behaviours where they genuinely improve UX.

---

### 1. Hero / Identity Block

The most prominent section. Must communicate at a glance:

- **Profile photo** — large, circular or softly rounded. Use `profileDisplayImage` if set, fall back to `image`.
- **Name** — prominent, with an optional verified badge if `isVerified: true`.
- **Headline** — `ConsultantProfile.headline` (up to 120 chars).
- **Short bio** — `User.bio` (up to 160 chars, used as a tagline beneath the headline).
- **Domain + SubDomains** — visually distinguish the primary domain from the sub-domains (e.g., domain is a label, sub-domains are chips).
- **Tags** — skill/technology tags as compact chips.
- **Location** — city + country if present, with a location pin icon.
- **Experience** — years of experience, formatted as "X yrs exp".
- **Key stats row** — rating (with star icon + numeric), total mentees helped, number of reviews (derived from the reviews array length). These should be visually prominent but compact.
- **Social / external links** — icons linking to LinkedIn, GitHub, Twitter/X, and Website — only render icons that have a non-null URL.
- **Primary CTA area** — one or two prominent action buttons that route to the appropriate booking flow. Consider: "Book a Session" (routes toward consultation), "View Plans" (scrolls to Services section). The exact labels and visual treatment are yours to decide.

> **Sidebar note:** In the old design, booking CTAs and stats lived in a sticky sidebar. Do **not** implement a sidebar. Instead, integrate the CTAs directly into the hero — and implement a **compact sticky top bar** that appears on scroll (after the hero scrolls out of view) containing the consultant's name, avatar, rating, and a single booking CTA. This replaces the sidebar's persistent presence.

---

### 2. About & Expertise

A section for the consultant's full profile in prose and structured form:

- **About / Full Description** — `ConsultantProfile.description` rendered as rich text (support newlines, maybe markdown-lite). Show a "Read more" expansion if it exceeds ~4 lines.
- **Mentoring Style** — `mentoringStyle` field if present — short paragraph.
- **Session Types** — render `sessionTypes` as labeled tags (e.g., "1-on-1", "Group", "Async").
- **Languages** — list of languages the expert teaches in.
- **Tools & Technologies** — `toolsAndTechnologies` array rendered as a tag cloud or icon grid. Where possible, use recognisable tech logos (e.g., via Devicons or Simple Icons CDN).
- **Video Intro** — if `videoIntroUrl` is set, embed it (YouTube/Loom iframe or a play-button thumbnail that opens a modal/lightbox).

---

### 3. Professional Background

A credibility section. Organise into three sub-sections rendered as visual timelines or card stacks:

**Work Experience**

- Company name, job title, date range (formatted as "Jan 2020 – Present" or "Jan 2020 – Dec 2022")
- Location if present
- Description (collapsible if long)
- Show the most recent 3 by default with a "Show more" toggle

**Education**

- Institution, degree, field of study, years
- Grade if present
- Brief description if present

**Certifications**

- Certification name, issuing org, issue date
- Expiry date if present ("Expires: …" or "No expiry")
- Credential URL as an external link if present

---

### 4. Services

The conversion centrepiece. Render all four service types. Use a tabbed or categorised layout if the expert has multiple service types — do not dump all cards into one undifferentiated list.

**Service types and their key display fields:**

**Consultations (1-on-1 sessions)**
Each `ConsultationPlan` is one card. Show per card:

- Title
- Duration (e.g., "60 min session")
- Price (formatted with currency symbol)
- Level badge (Beginner / Intermediate / Advanced)
- Language
- Description snippet (2-3 lines, expandable)
- Topics covered (as small chips)
- Learning outcomes (bullet list, collapsed by default)
- Materials included (if `materialProvided` is not "None")
- CTA button: "Book Now" → routes to checkout with this plan's ID

**Subscription / Mentorship Plans**
Each `SubscriptionPlan` card shows:

- Title
- Duration (e.g., "1-month plan")
- Price
- Session breakdown: "X calls/week · Y total sessions · Z total hours"
- Email support tier (General / Priority / None — render as a badge)
- Free trial badge if `freeTrialEnabled: true` (e.g., "30-min free trial available")
- Subscription contents/deliverables (`subscriptionContents` — list them)
- Learning outcomes
- CTA button: "Subscribe" and if `freeTrialEnabled`, a secondary "Start Free Trial" button

**Webinars (Live group sessions)**
Each `WebinarPlan` card shows:

- Title + cover image (`imageUrl` if set)
- Price (or "Free" if price is 0)
- Duration, language, level
- Max participants
- Certificate badge if `certificateProvided: true`
- Recording badge if `recordingEnabled: true`
- Learning outcomes
- Upcoming scheduled instances: render `webinarPlan.webinars` — show the next 1–2 upcoming (status = UPCOMING or similar), with date/time formatted in the viewer's local timezone. If no upcoming instances, show "No sessions scheduled — notify me" or a similar passive CTA.
- CTA: "Register" → routes to checkout

**Classes (Cohort programs)**
Each `ClassPlan` card shows:

- Title + cover image
- Price
- Program structure: "X months · Y sessions/week · Z total hours"
- Max participants (small group indicator if ≤ 10)
- Certificate + recording badges
- Curriculum (`classContents` — show titles as a numbered list, collapsed)
- Learning outcomes
- Upcoming cohort instances via `classPlan.classes`
- CTA: "Enrol" → routes to checkout

---

### 5. Availability

Help the consultee understand when the expert is generally reachable **without** exposing actual slot booking (that happens at checkout). This is a read-only display of their weekly schedule pattern.

- **Weekly schedule grid** — render `slotsOfAvailabilityWeekly` as a visual week-view (days as columns, time blocks as coloured bars). Convert `startTimeUtc` / `endTimeUtc` (minutes since midnight UTC) into the **viewer's local timezone** before rendering. Label each column Mon–Sun.
- **Custom one-off windows** — render `slotsOfAvailabilityCustom` entries as a compact list of date ranges (e.g., "Tue, 10 Mar · 4:00 PM – 7:00 PM IST"). Only show future ones. Cap at 5 with a "Show all" toggle.
- **Timezone note** — prominently display the consultant's own timezone (`User.timezone`) alongside a note that times are shown in the viewer's local timezone.
- This section should clarify the expert is generally available but actual slot selection happens during booking — include a soft CTA ("Check exact availability → Book a Session") linking to the consultation plan section.

---

### 6. Reviews & Social Proof

- **Aggregate rating display** — large numeric rating (e.g., "4.8"), a 5-star visual, total review count.
- **Rating distribution bar chart** — 5 bars (one per star level 5→1), showing the percentage/count breakdown. Derive this from the reviews array.
- **Review cards** — each `ConsultantReview` renders:
  - Reviewer avatar (circular, fallback to initials) + name
  - Star rating (as filled/empty stars)
  - Review text
  - Date posted (relative: "2 months ago" or absolute: "Jan 2026")
- **Pagination / load more** — show first 5 reviews, "Load more" fetches additional from the server. Design for a server action or API call pattern.
- If no reviews exist, show an empty state (not an error — just "No reviews yet").

---

## Sticky Navigation Bar (Scroll-Linked)

After the hero scrolls out of viewport, a compact bar should stick to the top of the page. It must contain:

- Consultant's avatar (small, circular) + name
- Rating (compact: "★ 4.8")
- Section anchor links: About · Services · Availability · Reviews (highlight the active section as the user scrolls)
- Primary CTA button ("Book a Session")

This replaces the sidebar pattern entirely and keeps the primary action always accessible without occupying permanent horizontal space.

---

## Architecture Guidance

You should engineer the component hierarchy from scratch. Some principles to follow:

1. **Server Components by default.** The page itself (`page.tsx`) is a React Server Component. Push data fetching to the top. Only extract client components where interactivity is genuinely needed (scroll tracking, tabs, expandable sections, modal/lightbox for video, load-more for reviews).

2. **Island architecture.** Keep interactive islands small and isolated. A tab switcher for service types is a client island; the plan cards inside are static. A "Read more" toggle is a client island; the text content is static.

3. **Dedicated component folder.** Create a `_components/` folder co-located with the route (`/explore/experts/[consultantId]/_components/`). Group by section, not by type — e.g., `hero/`, `about/`, `services/`, `availability/`, `reviews/`.

4. **Data transformation at the boundary.** The raw Prisma payload goes through a single transformation layer before touching any component. Create a `lib/transforms/consultantDetailTransform.ts` (or similar) that converts raw DB data into view-model objects — e.g., formatting prices, converting UTC minutes to local time display strings, deriving rating distributions. Components should receive pre-shaped view models, not raw DB rows.

5. **Currency + time utilities.** Build thin utility functions for:
   - `formatPrice(amount: number, currency: string) → string` (handles INR → ₹, USD → $, and uses `Intl.NumberFormat`)
   - `utcMinutesToLocalTime(minutes: number, timezone: string) → string`
   - `formatDateRange(start: Date, end: Date | null, isCurrent: boolean) → string`
   - `relativeTime(date: Date) → string` (for review dates)

6. **Responsive-first.** Mobile is primary. The layout must degrade gracefully to single-column on small screens. The sticky nav bar collapses gracefully on mobile (can hide anchor links, keep avatar + CTA).

7. **Skeleton loading.** Add Suspense boundaries with skeleton placeholders for sections that may load asynchronously (e.g., reviews via a separate fetch). Design skeleton components per section — not one global spinner.

8. **Accessibility.** Use semantic HTML (`<section>`, `<article>`, `<nav>`, proper `aria-label`s on icon-only links). Star ratings must have screen-reader text. Tab order must be logical.

---

## What the Agent Should NOT Do

- Do not build or mock any checkout/payment UI.
- Do not build any toast/snackbar/notification component.
- Do not build authentication flows or login prompts (treat unauthenticated state silently — booking CTAs simply redirect to login if session is absent, handled at the route level).
- Do not add any AI-powered features (matching, recommendations, etc.).
- Do not implement a sidebar layout — all persistent CTAs go in the sticky top bar.
- Do not reference or copy any existing component from the current codebase — this is a clean rebuild.

---

## Deliverable Expectations

The agent should produce:

1. A complete file tree for the rebuilt page and its components.
2. Full implementation of every file in the tree — no stubs, no "TODO: implement" comments.
3. The data transformation layer (`consultantDetailTransform.ts`).
4. Utility functions (formatting, time conversion).
5. Skeleton components per section.
6. The sticky nav bar as a client component with scroll tracking.
7. All TypeScript types inlined or imported from `@/types/` — no `any`.
8. TailwindCSS for all styling — no inline styles, no CSS modules unless there is a compelling reason.

---

_This prompt represents the full specification for the Expert Details page rebuild. The agent has full latitude over visual design, component naming, and UX micro-decisions not explicitly constrained above._
