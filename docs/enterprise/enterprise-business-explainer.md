> **⚠️ SUPERSEDED on 2026-04-08.** The canonical enterprise design is being written in PR2 (`feature/enterprise`) as `docs/enterprise/00-canonical-design.md`. This doc recommended deferring enterprise work until after MVP; that recommendation was overridden in favor of building a unified BUYER/PROVIDER/HYBRID organization model now. The strategy framing and B2C-vs-B2B feature discussion are still useful background. Retained for historical context.

# Enterprise & B2B: What It Means for Familiarise

> For: Business Advisor (Non-Technical Reader)
> Date: 2026-03-23
> Reading time: ~15 minutes

---

## Table of Contents

1. [What Is Enterprise/B2B?](#1-what-is-enterpriseb2b)
2. [B2C vs B2B: The Shopkeeper Analogy](#2-b2c-vs-b2b-the-shopkeeper-analogy)
3. [Why This Matters for Familiarise](#3-why-this-matters-for-familiarise)
4. [What Changes for the Consultant?](#4-what-changes-for-the-consultant)
5. [The Real Differences: A Side-by-Side Comparison](#5-the-real-differences-a-side-by-side-comparison)
6. [How Big Is This Change, Really?](#6-how-big-is-this-change-really)
7. [The Four Service Types: Enterprise vs Non-Enterprise](#7-the-four-service-types-enterprise-vs-non-enterprise)
8. [Indian Market Examples](#8-indian-market-examples)
9. [Recommended Strategy](#9-recommended-strategy)
10. [Summary for Quick Reference](#10-summary-for-quick-reference)

---

## 1. What Is Enterprise/B2B?

Let's start with the basics.

**B2C (Business-to-Consumer)** means we sell directly to individuals. A college student pays from their own pocket to get career guidance from an expert. This is what Familiarise does today.

**B2B (Business-to-Business)** means we sell to companies or institutions, and *they* provide our services to their people. A college pays us a monthly fee so their students can access career guidance. A company pays so their employees can access training sessions.

**Enterprise** is the large-scale version of B2B — think TCS, Infosys, large universities, government training programs. Enterprise customers typically need:
- A way for employees to log in using their company accounts (called "SSO" — Single Sign-On)
- One bill for the whole organization, not individual payments
- A dashboard for their HR/admin team to manage who gets access
- Custom branding (their logo on the platform)
- Formal contracts, purchase orders, and proper GST invoices

---

## 2. B2C vs B2B: The Shopkeeper Analogy

Imagine Familiarise as a tutoring center.

**B2C (Today):**
- Students walk in individually
- Each student picks their tutor and subject
- Each student pays at the counter themselves
- They come and go as they please
- Marketing: posters, social media, word of mouth

**B2B (Enterprise):**
- A college dean walks in and says: "I want 50 of my students to get career coaching here"
- The college picks which tutors and subjects are available
- The college pays one lump sum (not 50 individual payments)
- The college's admin decides which students get access
- Students still meet the same tutors in the same rooms — nothing changes for them
- Marketing: direct sales, proposals, presentations to decision-makers

**The key insight:** The tutoring itself doesn't change. What changes is who walks through the door, who pays, and who manages the relationship.

---

## 3. Why This Matters for Familiarise

### The Revenue Problem with B2C Only

With B2C:
- Every customer is one person paying ₹500-5,000 per session
- You need hundreds or thousands of individual customers
- Each customer can leave at any time (high churn)
- Revenue is unpredictable month to month
- Marketing cost per customer is high (you're reaching individuals one by one)

### The B2B Advantage

With B2B:
- One customer (a college, a company) might represent 50-500 users
- They pay monthly or annually — steady, predictable revenue
- Contracts are typically 6-12 months (low churn)
- One sales deal = dozens or hundreds of paying users
- Higher ARPU (Average Revenue Per User) because companies have bigger budgets than individuals

### Real Numbers (Hypothetical)

| Metric | B2C Only | B2C + B2B |
|--------|----------|-----------|
| Individual customers needed for ₹5L/month | ~500 paying ₹1,000 each | ~200 individuals + 3 orgs (50 seats each at ₹2,000/seat) |
| Revenue predictability | Low (monthly churn) | Higher (annual contracts) |
| Sales effort per ₹1L revenue | Acquire 100 individuals | Acquire 1 organization |
| Support burden | 500 individual tickets | 3 org admins who handle their own users |

---

## 4. What Changes for the Consultant?

**Almost nothing.**

This is the most important point. Whether a consultant is teaching an individual student or a corporate employee, their day-to-day experience is nearly identical:

- They set their availability the same way
- They create their courses/webinars the same way
- They join video calls the same way
- They review documents the same way
- They get paid the same way (the platform handles the split)

The only differences a consultant *might* notice:
- Their profile might show a company logo if they're part of a consulting organization
- Their revenue share might be slightly different (e.g., 85% instead of 80% if the org negotiated better rates)
- They might see "Enrolled via ABC Corp" on a student's profile

**The complexity of enterprise is entirely on the admin/billing side, not the teaching side.**

---

## 5. The Real Differences: A Side-by-Side Comparison

| Question | B2C (Individual) | B2B (Enterprise) |
|----------|-------------------|-------------------|
| **Who finds us?** | Individual searches Google, Instagram, word of mouth | HR manager, L&D team, college placement cell |
| **Who decides to buy?** | The person who will use it | A manager or committee (not the end user) |
| **Sales cycle** | Minutes to hours (impulse or quick decision) | Weeks to months (proposals, approvals, budgets) |
| **Who signs up?** | Individual creates own account | IT admin or HR sets up accounts (possibly using company login) |
| **Who pays?** | Individual's credit card/UPI | Company bank transfer, purchase order, invoice |
| **Price sensitivity** | Very high (₹500 matters) | Lower per-user (₹2,000/seat is normal for corporate training) |
| **Contract length** | Per session or monthly | Quarterly, annual, or multi-year |
| **Support expectation** | FAQ + email | Dedicated account manager, SLA guarantees |
| **Brand requirement** | Our platform brand | Often want their own logo/branding |
| **Invoice requirement** | Receipt is enough | Formal GST invoice, sometimes with PO number |
| **Data/Privacy** | Standard terms | May need data processing agreements, compliance certificates |

---

## 6. How Big Is This Change, Really?

Think of the Familiarise platform as a building with 10 floors:

```
Floor 10: Marketing website & landing pages
Floor 9:  Explore/Discovery (find consultants)
Floor 8:  Consultant profiles & availability
Floor 7:  Booking & scheduling engine
Floor 6:  Video calls & screen sharing (Stream.io)
Floor 5:  Chat & messaging (Stream.io)
Floor 4:  Document upload & review
Floor 3:  Payment processing (Stripe, Razorpay)
Floor 2:  Notifications & emails
Floor 1:  User authentication & login
```

**For enterprise, here's what changes:**

| Floor | Change Needed | Effort |
|-------|--------------|--------|
| Floor 10 | Add enterprise landing page + pricing | Small |
| Floor 9 | Add "Companies" section to explore | Small |
| Floor 8 | No change (same profiles) | None |
| Floor 7 | No change (same booking engine) | None |
| Floor 6 | No change (same video calls) | None |
| Floor 5 | No change (same chat) | None |
| Floor 4 | No change (same document review) | None |
| Floor 3 | Add org-level billing + invoicing | Medium |
| Floor 2 | Add org-specific notifications | Small |
| Floor 1 | Add company login (SSO) | Medium |
| **NEW** | Organization admin dashboard | Large |
| **NEW** | Seat management & team analytics | Medium |

**Summary: 7 out of 10 floors don't change at all.** The core teaching/learning experience is identical. The new work is primarily an "Organization Admin Dashboard" (a new section for company admins to manage their people) and adjustments to login and billing.

**Honest assessment: ~70% of the application stays exactly the same. The 30% that changes is admin, billing, and access control — not the core product.**

---

## 7. The Four Service Types: Enterprise vs Non-Enterprise

Familiarise offers four types of services. Here's how enterprise affects each:

### Consultations (1-on-1 Sessions)

Think of this like a private tutoring session.

- **Today (B2C)**: Ramesh pays ₹1,000 from his pocket and books a 1-hour session with a career coach
- **Enterprise**: TCS pays for Ramesh to have a 1-hour session with a career coach. Ramesh doesn't pay anything — his company's subscription covers it.
- **What changes for the coach?** Nothing. Same session, same video call, same documents.
- **Technical change**: Small — just track which company paid

### Subscriptions (Recurring Monthly Mentoring)

Think of this like a monthly gym membership, but for mentoring.

- **Today (B2C)**: Priya pays ₹5,000/month for 4 sessions with a mentor
- **Enterprise**: ABC College buys 20 mentoring seats. The placement cell assigns students to mentors. The college pays one invoice.
- **What changes for the mentor?** Nothing. Same weekly sessions, same schedule.
- **Technical change**: Medium — need to track "seats" (how many students the college bought access for)

### Webinars (One-Time Group Sessions)

Think of this like a guest lecture or workshop.

- **Today (B2C)**: 50 individuals each pay ₹200 to attend a "Resume Building" webinar
- **Enterprise**: Infosys pays ₹20,000 for 100 employees to attend the same webinar. Employees don't pay individually.
- **What changes for the speaker?** Nothing. Same presentation, same Q&A, same recording.
- **Technical change**: Medium — bulk registration + recording access management

### Classes (Multi-Session Courses)

Think of this like a semester-long course.

- **Today (B2C)**: 15 individuals each pay ₹10,000 for a 12-session Python course
- **Enterprise**: A coding bootcamp partners with us and enrolls 3 batches of 30 students each. The bootcamp pays monthly.
- **What changes for the instructor?** Almost nothing. They might see larger class sizes and the bootcamp's logo on the course page.
- **Technical change**: Largest — need cohort management (assigning groups of students), progress tracking (who completed what), and potentially org-branded certificates.

### Summary Table

| Service Type | How Different for Enterprise? | Main Change |
|-------------|------------------------------|-------------|
| Consultations | Very similar | Payment routing only |
| Subscriptions | Somewhat different | Seat management added |
| Webinars | Somewhat different | Bulk access + recording library |
| Classes | Most different | Cohort management + progress tracking |

---

## 8. Indian Market Examples

To make this concrete, here's how similar Indian companies handle B2C vs B2B:

### Byju's (Now Think & Learn)
- **B2C**: Parents buy courses for their children (₹10K-1L/year)
- **B2B** ("Byju's for Business"): Companies buy training modules for employees
- **What changed?** Added enterprise dashboard, bulk licensing, LMS integration. Core content delivery stayed the same.

### UpGrad
- **B2C**: Individuals enroll in courses (₹2-6L per course)
- **B2B** ("UpGrad for Business"): Companies sponsor employees for upskilling
- **What changed?** Added organization accounts, bulk enrollment, manager dashboards, custom learning paths. The courses themselves are identical.

### Unacademy
- **B2C**: Students subscribe individually for exam prep
- **B2B** ("Unacademy for Institutes"): Coaching centers white-label Unacademy content
- **What changed?** Added institutional accounts, batch management, custom branding. The video lectures are the same.

### The Pattern

In every case:
1. The core product (teaching/content) stayed the same
2. They added an "organization layer" on top (admin dashboard, billing, access control)
3. The first few enterprise deals were manual (custom contracts, hand-held onboarding)
4. They automated only after understanding what enterprise customers actually needed

---

## 9. Recommended Strategy

### Phase 1: Launch B2C First (Now → Month 6)

- Focus entirely on individual consultees
- Validate that consultants can deliver, students find value, payments work
- Don't build any enterprise features
- What we already have (basic org models in the database) is a free placeholder — it costs nothing to keep

### Phase 2: Manual Enterprise (Month 6 → Month 12)

When the first college or company says "we want this for our people":

- Onboard them manually (you personally set up their accounts)
- Custom pricing (negotiate directly, don't automate)
- Manual billing (generate invoices yourself)
- Students/employees use the regular B2C flow (individual accounts)
- **Why manual?** You learn what they actually need. Every assumption in the design docs might be wrong. The first 3-5 enterprise customers will teach you more than 6 months of pre-building.

### Phase 3: Automated Enterprise (Month 12+)

After 3-5 manual enterprise deals, you'll know:
- What features they actually use vs what they say they want
- Whether SSO is truly necessary (some small colleges won't care)
- Whether recording libraries matter or if live sessions are enough
- What pricing model works (per-seat, flat fee, usage-based)

Then build the automated version based on real data.

### Why Not Build Enterprise Now?

| Concern | Response |
|---------|----------|
| "What if a big customer shows up?" | Handle them manually. Every SaaS company's first 5 enterprise deals are custom. |
| "Won't we lose deals to competitors?" | No competitor (TopMate, Preplaced, Metvy) has enterprise features either. |
| "Isn't it cheaper to build now?" | No. Building without customer feedback means you'll build the wrong thing and rebuild later. |
| "What about the college market?" | Colleges have long procurement cycles (months). You have time. |
| "Will it be hard to add later?" | No. The technical design is "additive" — we add new features without breaking existing ones. 70% of the app stays untouched. |

---

## 10. Summary for Quick Reference

**What is enterprise?**
Companies or institutions buying our services for their people, instead of individuals buying for themselves.

**How different is it technically?**
70% of the app stays the same. The 30% that changes is admin, billing, and login — not the core teaching/consultation experience.

**How different is it for consultants?**
Almost zero difference. They teach the same way regardless of who's paying.

**Should we build it now?**
No. Launch B2C first. Handle the first few enterprise customers manually. Build the automated version only after you understand what they actually need.

**What's the risk of waiting?**
Very low. No competitor has enterprise features. The technical changes are additive (we add, not rebuild). Manual onboarding works for the first 3-5 enterprise customers.

**What's the risk of building too early?**
High. We'd spend 5-7 months building features that might not match what customers actually want, delaying the B2C launch that generates our first revenue.

**The one-line summary:**
_Enterprise is a "different front door to the same building." The rooms inside (consultations, webinars, classes) are identical — we just need to add a reception desk for companies._
