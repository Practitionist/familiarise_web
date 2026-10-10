# 02 — 2026 Consulting, Retainer & Live-Session Competitive Teardown (`KEEP / MODIFY / ADD / DELETE`)

> **Version:** 1.0 (October 2026)
> **Scope:** Comprehensive teardown of 2025–2026 competitors across 1:1 Expert Call Platforms, Trial-to-Subscription Marketplaces, Webinar-to-Cohort Engines, Client Workspaces, and B2B Coaching Networks, plus Familiarise's `KEEP / MODIFY / ADD / DELETE` product strategy.

---

## 1. The 2026 Expert Monetization Landscape: Why Link-in-Bio Call Tools Leak & Why Retainer Workspaces Win

Between 2023 and 2026, the online consulting and creator-monetization market split into two radically different economic realities:

1. **The Low-LTV "1-Call Disintermediation Trap" (`Topmate`, `Clarity.fm`, `Superpeer`, `Intro.co`):**
   - Platforms that act merely as a **"Calendar Link + Payment Gateway + External Google Meet Link"** suffer from **70%–85% off-platform leakage after Session #1**.
   - In India, a client books a `₹500` 30-minute call on Topmate, meets the consultant on Google Meet, exchanges WhatsApp numbers, and pays any subsequent `₹15,000–₹30,000` retainer via personal UPI to avoid the 10–20% platform fee.
   - As a result, pure 1:1 link-in-bio platforms average **1.15–1.30 calls per buyer** (`< ₹150` platform LTV), making paid user acquisition impossible.
2. **The High-LTV "Trial $\to$ Subscription & Persistent Workspace" Winners (`Preply`, `Preplaced`, `MentorCruise`, `Maven`, `Moxo`):**
   - **Preply** (valued at **$1.2B** in Jan 2026, $150M Series D, EBITDA-positive) eliminated one-off regular lessons and built a mandatory **Trial Session $\to$ 28-Day Auto-Renewing Subscription** engine with sliding commission tiers (`33% → 18%`), generating **12–36+ sessions per client**.
   - **Preplaced.in** (`~$18.2M` est. ARR) and **MentorCruise** pair a low-friction **Trial Call** with **Multi-Month Mentorship Subscriptions** (`₹4,000–₹35,000/mo`) backed by escrow, structured roadmaps, and document reviews.
   - **Maven** uses free/low-ticket **30-minute "Lightning Lessons" (Webinars)** to drive 3%–8% conversion into **$500–$2,500 Live Cohorts / Classes**, with 40%+ of seats expensed to corporate L&D budgets.

---

## 2. Comprehensive 2025–2026 Competitor Matrix

| Competitor | Geography & Scale | Pricing & Take Rate | Core Wedge | Fatal Weakness / How `Familiarise` Wins |
| :--- | :--- | :--- | :--- | :--- |
| **Topmate.io** | India + Global (FY24 rev `< ₹10 Cr` despite large creator base) | **10%** on direct link (`+18% GST` + PG fee); **20%** on Marketplace discovery | Zero-friction link-in-bio for `₹199–₹999` 1:1 calls & PDF downloads | **80% 1-Call Leakage & No Workspace:** Uses external Google Meet; no native video room, no fill-order subscription cycles, no multi-session live classes, and no B2B Net-60/PO enterprise engine. **Familiarise's `0%` `OWN_LINK` fee + native Stream.io + Subscription engine directly beats Topmate.** |
| **Preplaced.in** | India + Global (`~$18.2M` est. ARR) | `₹99`/Free Trial $\to$ `₹4,000–₹35,000/mo` packages (~20–30% margin) | Long-term 1:1 FAANG interview prep & career transition coaching | **Single-Vertical Ceiling:** Restricted to software/PM interview prep; lacks multi-session **Live Classes**, **1,000-seat Webinars**, **Host Agency RateCards**, and horizontal consulting (Finance/CA, Legal, Startups, Design). |
| **Preply & iTalki** | Global (`Preply`: **$1.2B** valuation; `iTalki`: package escrow leader) | **Preply**: 100% on Trial, `33% → 18%` sliding scale.<br>**iTalki**: 0% on Trial, `15%` on packages. | **Trial $\to$ Recurring Subscription / Package Escrow** + native classroom | **Academic / Language Tutoring Only:** Built for language/school tutors ($10–$30/hr), not high-ticket professional consulting, document review (`AppointmentDocument`), or B2B corporate L&D procurement. |
| **Intro.co & Clarity.fm** | US / Global | **Intro**: `25%–30%` cut ($250–$2,500/hr).<br>**Clarity**: `15%` cut (per-minute phone billing). | High-status C-suite / founder 1-off advice calls | **Novelty 1-Off Calls (1.1x LTV):** Zero recurring subscription retainers, zero live group classes, zero collaborative document workspaces, and no India UPI/GST support. |
| **MentorCruise & GrowthMentor** | Global | **MentorCruise**: 7-day trial $\to$ `$120–$600/mo` (`16–20%` cut).<br>**GrowthMentor**: `$99/mo` buyer membership. | Async chat + 1:1 calls bundled into monthly retainers | **No Live Group Classes or Webinar Funnels:** Pure 1:1 mentorship; lacks Familiarise's `Webinar → Class` 1:many leverage and `SPONSOR × HOST` B2B accounting spine. |
| **Maven & Luma (`lu.ma`)** | Global | **Maven**: `10%` fee on cohorts ($500–$3K).<br>**Luma**: `5%` fee (or `$59/mo` for `0%`). | **Maven**: Free Lightning Lesson $\to$ Paid Cohort.<br>**Luma**: Frictionless event/webinar pages. | **Maven** is too expensive (`$800+`) for Indian prosumers and lacks 1:1 consultation subscriptions; **Luma** is a standalone event calendar with no multi-session class protection or 1:1 retainer loop. |
| **Stan Store & TagMango** | US (`Stan`: `$29–$99/mo`) & India (`TagMango`: `₹0–₹30K/mo + 0–10%`) | SaaS subscription + transaction cut | Link-in-bio digital downloads (`Stan`) & webinar-to-community funnels (`TagMango`) | **Info-Product / Influencer Positioning:** Neither offers a native WebRTC consulting workspace, GiST-locked 1:1 slot allocation, versioned document review, or enterprise PO/GST/TDS compliance. |
| **Moxo & Simply.Coach** | Global & India B2B SaaS | SaaS per-seat subscription (`$29–$100+/mo`) | Client portal for document exchange, session notes & action items | **Pure Back-Office SaaS (Zero Marketplace or Checkout):** Consultants must bring their own clients and stitch together Zoom + Razorpay. Familiarise gives them marketplace discovery, checkout, video, and workspace in one. |

---

## 3. Feature-by-Feature Audit for `Familiarise`: `KEEP`, `MODIFY`, `ADD`, `DELETE`

### 3.1 ✅ `KEEP` (Already-Built Production Moats in `familiarise_web` & `familiarise_mobile`)
1. **The 4 Synchronous Service Modalities (`Consultation`, `Trial`, `Subscription`, `Webinar` + `Class`):**
   - Covers the entire spectrum of synchronous human expertise—from a 30-min diagnostic trial (`Trial`) to a 6-month 1:1 retainer (`Subscription`), a 1,000-seat broadcast (`Webinar`), and a multi-session group coaching series (`Class`).
2. **3-Layer Zero-Collision Scheduling & Slot Allocation (`lib/scheduling/allocationService.ts`):**
   - Upstash Redis locks + `SERIALIZABLE` retry + PostgreSQL GiST exclusion constraint (`occurrence_no_confirmed_overlap`), supporting `useRequestedSlots`, `manualAllocate`, `autoAllocate` (`preferenceScoring.ts`), and `WindowBackupInterest` contended-slot queues.
3. **Production-Hardened Stream.io Video & Chat (`lib/meetings/`, `lib/stream/`):**
   - Server-only room provisioning, 1,000-seat backstage/stage hand-raise moderation, elastic duration caps (`+30m` grace + in-call `+15m` host extend), device-level `SessionOutcome` classification (`HELD`, `HOST_ABSENT`, `LEARNER_ABSENT`), recording consent & `/explore/recordings` replay marketplace, and booking-gated Stream Chat.
4. **26-Invariant Double-Entry Financial Spine & 2-Axis (`SPONSOR × HOST`) Enterprise Engine:**
   - PostgreSQL trigger-enforced zero-sum ledger (`ledger_txn_balanced`), multi-leg `PaymentLeg` splitting, Referral V2 (`0%` `OWN_LINK` take rate), Section 194-O TDS (`TDSRecord`), MSME Sec 43B(h) tracking, and the 4-rail Enterprise engine (`PERSONAL`, `WALLET`, `INVOICE` Net-60 + PO match, `LICENSE`).
5. **100%-Synced Flutter + Dart Frog Mobile App (`familiarise_mobile`):**
   - `93/93` Prisma models synced with `WebHandoffDialog` for App Store `3.1.3(b)/(d)` compliance (0% Apple/Google IAP tax on human consulting).

---

### 3.2 🔧 `MODIFY` (Sharpen Positioning & Eliminate Cross-Product Overlap with `Elluminar`)

| Current State in `familiarise_web` | Modified Specification | Strategic & Economic Rationale |
| :--- | :--- | :--- |
| **1. `certificateProvided` on `WebinarPlan` (`L4048`) & `ClassPlan` (`L4166`)** | **Rename/Reposition as `Attendance Receipt` (Never a "Skill Certificate"):**<br>Generate printable **Session Attendance Receipts** (showing `MeetingAttendance` duration + GST Invoice ref) for corporate L&D reimbursement. Reserve **Verified Skill Credentials** exclusively for **Elluminar**. | Familiarise has no quizzes, assignments, coding sandboxes, or graded rubrics. Issuing "Skill Certificates" for passive webinar attendance dilutes Elluminar's cryptographic Proof-of-Work credentials (`/verify/[code]`). |
| **2. `Class` Terminology & Positioning (`feat/rename-class-to-cohort` branch)** | **Frame `Classes` as "Live Group Series / Group Coaching Batches":**<br>Keep the `ClassPlan`/`Class` Prisma models intact (`#705` schema freeze), and position them in UI as **calendar-driven live group sessions** (coaching groups, live tutoring batches, discussion cohorts) distinct from Elluminar's LMS Courses. | Prevents creator/buyer confusion between a **Familiarise Live Class** (synchronous calendar sessions + handouts) and an **Elluminar Course** (async LMS spine + quizzes + assignments + sandboxes + rubric projects). |
| **3. Paid `Trial` Conversion Flow (`SubscriptionPlan.trialPriceInPaise`)** | **Add 48-Hour 100% Trial-Fee Credit on Subscription Upgrade + Free Replacement Guarantee:**<br>When a consultee completes a paid `Trial` (`₹199–₹499`) and purchases the parent `SubscriptionPlan` within 48 hours, automatically credit 100% of `trialPriceInPaise` via a `DISCOUNT` / credit leg. | Directly replicates Preply and Preplaced's highest-converting retention hook, lifting `Trial → Subscription` conversion to 25%–35%. |
| **4. Marketplace Take Rate on Multi-Month Subscriptions (`2000 bps` flat)** | **Introduce Loyalty Take-Rate Decay on Marketplace Subscriptions:**<br>Keep `0%` on `OWN_LINK` (`ExpertCustomerRelationship`). On marketplace-discovered `Subscription` renewals (`renewedFromSubscriptionId`), step down platform fee from **`20%` (Cycle 1) $\to$ `15%` (Cycles 2–3) $\to$ `10%` (Cycle 4+)**. | Removes the consultant's financial incentive to take a loyal long-term retainer client off-platform to WhatsApp/UPI after Month 1. |

---

### 3.3 ➕ `ADD` (High-Leverage Consulting Workspace Features — Zero LMS Bloat)

1. **In-Call Side-by-Side Document Co-Viewing & Pin Annotation (`/meetings/[id]`):**
   - Today, `AppointmentDocument` supports async pre-call and post-call file review (`lib/documents/document-review.ts`).
   - **Addition:** Embed an interactive side-by-side PDF/Document viewer panel directly inside the Stream.io meeting room (`/meetings/[id]`) so consultant and consultee can view the uploaded Resume, Pitch Deck, Tax Sheet, or Contract together during the live call, drop page-pinned review notes, and approve/request revisions in real time.
2. **AI Post-Call Summary & Shared "Client Action-Item Tracker":**
   - After a 1:1 Consultation, Trial, or Subscription session transitions to `HELD`, generate a structured **Session Summary + 3–5 Checkable Client Action Items** (e.g., *"1. Update LinkedIn headline; 2. Upload revised resume v2 before Session #2"*), stored in existing relationship/document metadata (`#705`-compatible).
   - Unlike Elluminar's graded LMS assignments, Action Items have no test runners or pass/fail scores—they serve as a **persistent consulting engagement log** that keeps clients anchored to the platform between calls.
3. **In-Room Last-5-Minutes "Next-Slot & Subscription/Class Upsell" Drawer:**
   - Surface a non-intrusive card inside `/meetings/[id]` during the final 5 minutes of a call:
     - **In `Trial` / `Consultation` rooms:** *"Upgrade to [Consultant]'s Monthly Retainer within 48h and get 100% of today's trial fee credited"* or *"Book your next 1:1 slot now."*
     - **In `Webinar` rooms:** *"Enroll in [Consultant]'s upcoming Live Group Class (`X` seats left) or book a 1:1 Diagnostic Trial."*
4. **Cross-Product `Practitionist` Bridge to `Elluminar`:**
   - Allow consultants who also author Courses or Mentor-Guided Projects on **Elluminar** to showcase their Elluminar catalog on their Familiarise profile, and accept incoming 1:1 Mock Interview / Resume Review / Advisory bookings routed from Elluminar (`#19` replacement).

---

### 3.4 ❌ `DELETE` / `DO NOT BUILD` in `Familiarise` (Enforcing the Portfolio Boundary)

1. **DO NOT Build Quizzes, Auto-Graded Assignments, Coding Sandboxes, Excalidraw Canvases, or Rubric-Graded Projects in `familiarise_web`:**
   - All asynchronous LMS primitives, interactive work-artifact sandboxes, and rubric/defense project workflows belong 100% in **`Elluminar` (`elluminar_web`)**.
2. **DO NOT Build Standalone E-Book / Digital Template Storefronts (`Issue #1135` Digital Products part):**
   - Low-ticket digital file selling turns Familiarise into a cluttered Gumroad clone and complicates GST SAC classification (`9983` consulting vs digital goods). Keep `PlanMaterial` strictly attached to Consultations, Subscriptions, Webinars, and Classes.
3. **DO NOT Route 1:1 Live Consulting Through Merchant-of-Record (MoR) Gateways (Dodo / Polar / Paddle):**
   - As proven in `docs/payments/gateways/gateway-evaluation-2026.md` (`PR #2000`), MoR providers explicitly ban live 1:1 human coaching and consulting in their AUPs. Use **Razorpay (Primary INR) + Cashfree (Backup INR) + Tazapay / Xflow (Cross-Border USD/EUR/GBP)**.
