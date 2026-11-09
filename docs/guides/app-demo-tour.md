# Familiarise — Guided App Tour (for the family demo)

A phased, grouped walkthrough of the whole platform. The logins below exist in the
default `SEED_MODE=small` seed; the Platform Admin and Platform Staff rows also
require `SEED_WITH_STAFF=true`.
**Operator accounts (Admin, Staff) use the `SEED_OPERATOR_PASSWORD` value from your local `.env`; ask the lead. All other accounts use the seed default password (see `prisma/seedFiles/1a-create-users.ts`).**

> Tip: do the demo in **Incognito windows** — one per role — so sessions don't collide,
> and so the browser-extension noise (the `fdprocessedid` warnings) stays out of the way.
> Start the app first: `npm run dev` → open `http://localhost:3000`.

---

## 🔑 Logins (one per role)

| Role                       | What they are                                     | Email                               | Password                 |
| -------------------------- | ------------------------------------------------- | ----------------------------------- | ------------------------ |
| **Consultee**              | A customer who books sessions                     | `patrick.anderson@outlook.com`      | seed default             |
| **Consultant**             | An expert who sells & runs sessions               | `aarav.anderson@gmail.com`          | seed default             |
| **Org admin (Enterprise)** | Runs the **Wipro** company workspace              | `tour-owner@familiarise.dev`        | seed default             |
| **Sponsored employee**     | A Wipro learner who books on the company's budget | `priya.anderson@yahoo.com`          | seed default             |
| **Platform Admin**         | Familiarise back-office (money, verification)     | `qa-admin-2@qa.familiarise.invalid` | `SEED_OPERATOR_PASSWORD` |
| **Platform Staff**         | Support / operations                              | `qa-staff-1@qa.familiarise.invalid` | `SEED_OPERATOR_PASSWORD` |

> The consultee and sponsored-employee logins are among the first three seeded users
> for their role, so they are always onboarded. Operator accounts sign in without TOTP
> only when `NEXT_PUBLIC_SENTRY_ENVIRONMENT` is `preview` or `development`;
> production asks for TOTP.

**Extra orgs to show variety:** _IIT Madras_ (owner `charlotte.anderson@gmail.com`) and
_LearnPro Academy_ (owner `daniel.anderson@outlook.com`). Seeded counts depend on
`SEED_MODE`: the default `small` seed creates 30 consultants and 40 consultees, and
`SEED_WITH_STAFF=true` adds 4 staff and 3 admins. Pick any name from the same pattern
(`firstname.lastname@domain`) if you want more.

---

## 🎬 The tour, phase by phase

Each phase = a person's point of view. Go in order — it tells a story (a marketplace →
the customer → the expert → companies → the back office → the money engine).

### Phase 1 — "What anyone sees" (no login) · _the storefront_

**Where:** `http://localhost:3000` → **Explore**

- The **landing page** and **Explore** grid — browse experts and programs.
- Open an **expert's profile**: their bio, reviews, and the **availability heat-map**
  (green = open slots), and the **plans** they offer.
- Show the four **product types**: a 1-on-1 **Consultation**, a recurring
  **Subscription**, a group **Webinar**, and a multi-session **Class**.
- Show **search & filters** (topic, price, language) and the **enterprise org pages**
  (`/explore/enterprise/organisations`).

> Say: _"It's a marketplace — like a storefront of experts you can book."_

### Phase 2 — The customer journey · _log in as the Consultee_ (`patrick.anderson@outlook.com`)

**Where:** lands on the **Consultee dashboard** after login.

- **Dashboard tour:** upcoming & past sessions, payment/invoice history, and the sessions the learner asked to be told about.
- **Book a session:** Explore → an expert → pick a plan → the **request dialog** → choose
  a time on the **slot picker / heat-map**.
- **Checkout:** show the payment screen — **Razorpay / Stripe**, a **discount code**,
  **referral credits**, and the booking confirmation. _(Use the dev "Mock Pay" button so
  you don't need a real card.)_
- **Manage a booking:** **reschedule** and **cancel** an existing session (watch the
  "this slot was just taken" handling if a slot is gone).
- **The session itself:** open a booked appointment → **join the video room** (Stream),
  share **documents**, and **chat**.
- **Referrals:** the consultee's referral code / credits.

> Say: _"This is the whole customer experience — find, book, pay, meet, follow up."_

### Phase 3 — The expert journey · _log in as the Consultant_ (`aarav.anderson@gmail.com`)

**Where:** the **Consultant dashboard**.

- **Home / earnings** overview.
- **Requests tab:** a pending booking request → **allocate slots** — show the three modes:
  **auto-allocate**, **manual-allocate**, and **use requested slots**.
- **Event planner / heat-map:** the calendar with slot states — _available, booked,
  partially booked, scheduling period_ — and reschedule/cancel from here.
- **Availability settings:** set **weekly** recurring slots and **custom** one-off slots.
- **Plans:** create/edit a Consultation, Subscription, Webinar, or Class.
- **Documents:** review documents a consultee uploaded.
- **Reviews**, **payout account** setup, and **earnings → payouts** (with the UTR once paid).

> Say: _"This is the expert's cockpit — their calendar, their offerings, and their money."_

### Phase 4 — The enterprise side (B2B) · _log in as the Org admin_ (`tour-owner@familiarise.dev`)

**Where:** the **Wipro** organization dashboard.

- **Programs** (what the company sponsors), **Members** (employees), **Contracts** &
  **Rate cards**.
- **Billing account & wallet** (the company's prepaid balance / top-ups), **Payouts**,
  and **Invoices** (GST-compliant, gapless numbering).
- **Settings:** **SSO** (OIDC), **webhooks**, audit log, and the **analytics** dashboard.
- **Then switch** to a **sponsored employee** (`priya.anderson@yahoo.com`) and book a session
  **on the company's budget** — to show the funding flow end-to-end.

> Say: _"Companies sponsor their teams — they fund a wallet, set who can book what, and
> get one compliant invoice."_ Other orgs to peek at: **IIT Madras**, **LearnPro Academy**.

### Phase 5 — The back office · _log in as Admin_ (`qa-admin-2@qa.familiarise.invalid`)

**Where:** the **Admin** dashboards.

- **Organizations:** verification / KYB / MSME status.
- **Payments:** reconciliation, **refunds**, **disputes/chargebacks**.
- **Invoices:** counters, IRN/e-invoice status.
- **Moderation / profile verification**, and **overage events**.
- Then **Staff** (`qa-staff-1@qa.familiarise.invalid`) for the support/operations view.

> Say: _"This is the control room that keeps payments correct and the marketplace safe."_

### Phase 6 — The money & trust engine · _the impressive deep-dive_

Mostly visible through Admin → Payments/Invoices, Consultant → Earnings, and Org → Billing:

- **Double-entry ledger** — every rupee is a balanced entry; balances are derived, not guessed.
- **Earnings → Payouts** with **TDS** withheld, and **UTR** captured on completion.
- **Refunds, disputes, credit notes**, **GST** invoices, and **wallet/credits**.
- **Resilience:** no double-booking even under a rush (locks + database guards); the loser
  of a race gets a clean "slot just taken" message, never a corrupted booking.

> Say (to the techie in the family): _"It's built like a bank ledger — everything balances
> to the paise, and two people can never grab the same seat."_

### Phase 7 — The "wow" extras

- **Live-ish freshness:** open the planner in two tabs; book a slot in one → the other
  refreshes on focus.
- **Heat-map states:** show available vs booked vs partially-booked vs scheduling-period.
- **Notify me:** on a sold-out webinar or class (the appointment waitlist) or a 1:1 time someone else holds (slot backup interest), everyone who asked is told at once when it frees, and the first to pay gets it. Nothing is reserved and nobody is queued.
- **Trial sessions**, and the **video meeting room** with recording.

---

## 🗺️ Coverage matrix (so nothing's missed)

| Subsystem                                                         | Where to show it    | Role(s)               |
| ----------------------------------------------------------------- | ------------------- | --------------------- |
| Explore / search / detail pages                                   | Phase 1             | Public                |
| Booking (consult/subscription/webinar/class/trial)                | Phases 2–3          | Consultee, Consultant |
| Slot allocation (auto / manual / requested)                       | Phase 3 (Requests)  | Consultant            |
| Heat-map / event planner                                          | Phases 3, 7         | Consultant            |
| Reschedule / cancel / notify me                                   | Phases 2, 3, 7      | Consultee, Consultant |
| Checkout & payments (Razorpay/Stripe, wallet, discounts, credits) | Phase 2             | Consultee             |
| Earnings / payouts / TDS / UTR                                    | Phases 3, 6         | Consultant, Admin     |
| Refunds / disputes / credit notes                                 | Phases 5, 6         | Admin                 |
| Invoices / GST                                                    | Phases 4, 5         | Org admin, Admin      |
| Ledger / reconciliation                                           | Phase 6             | Admin                 |
| Enterprise (orgs, programs, contracts, rate cards, sponsorship)   | Phase 4             | Org admin             |
| Wallet top-ups / billing account                                  | Phase 4             | Org admin             |
| SSO / webhooks / audit / analytics                                | Phase 4             | Org admin             |
| Onboarding                                                        | start of Phases 2–4 | all                   |
| Settings (availability, profile, payout account)                  | Phase 3             | Consultant            |
| Documents upload / review                                         | Phases 2, 3         | Consultee, Consultant |
| Meetings (video) / recordings                                     | Phases 2, 7         | Consultee, Consultant |
| Chat & notifications                                              | Phase 2             | Consultee             |
| Referrals / discounts                                             | Phase 2             | Consultee             |
| Moderation / verification                                         | Phase 5             | Admin                 |
| Admin & Staff dashboards                                          | Phase 5             | Admin, Staff          |

---

## 💡 Demo tips

- **One Incognito window per role** — avoids session clashes and lets you flip between
  "customer" and "expert" side by side.
- Use the dev **"Mock Pay"** button at checkout — no real card needed.
- If a screen needs an ID in the URL, just navigate from the dashboard — the app routes you.
- Reset feeling stuck? Log out, or open a fresh Incognito window.
- Every login uses the seeded `familiarise` dev database. Non-operator logins use
  the shared seed default in `docs/team/mock-credentials.md`; operator logins use
  `SEED_OPERATOR_PASSWORD`. These are never real accounts.
