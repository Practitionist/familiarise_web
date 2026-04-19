# Familiarise enterprise — sales playbook

> **Audience:** Investors · Sales · Marketing
> **Simple language — no code.**

## What enterprise means on Familiarise

Familiarise is a marketplace where experts — consultants, teachers,
mentors, coaches — offer their knowledge to learners through paid
sessions.

**Enterprise** is when a whole organisation (a school, a company, a
coaching institute, a professional association) wants to be part of
that ecosystem.

Every organisation we work with has two independent capabilities:

| Capability | What it means |
|------------|---------------|
| **Sponsor** | The org pays for its people's sessions. |
| **Host**    | The org brings its own experts and earns from their sessions. |

Most orgs do one or the other. Some — universities with their own
teachers, EdTechs with their own experts, alumni networks — do both.
We call those **Hybrid**.

## Funding sources (for sponsor capability)

A sponsor org picks **one funding source** that governs how its
people's sessions get paid for:

| Funding source | One-liner | Typical customer |
|----------------|-----------|------------------|
| **Personal**   | Members pay at checkout with their own card. The org gets a dashboard but no spend. | Large corp that wants visibility only. |
| **Wallet**     | Org pre-loads a credit pool; members book freely and credits deduct automatically. | Mid-market with a defined L&D budget. |
| **Invoice**    | Members book freely all month; we send one invoice at month-end, NET-30 / NET-60. | Enterprise with procurement / PO workflow. |
| **License**    | Flat upfront fee buys unlimited sessions for the contract period. | University or training partner buying in bulk. |

Host capability doesn't need a funding source — the org *earns* money
rather than pays us.

## The combinations we actually sell

Rather than a 3 × 4 grid of every possible pairing, we sell from a
short, validated list:

| # | Capability | Funding | Typical customer | What makes them biased toward this combo |
|---|------------|---------|------------------|------------------------------------------|
| 1 | Sponsor only | Personal | Tata Group, Infosys L&D, any corp with individual reimbursement | "We don't want to hold a budget; just let our people book and show us reports." |
| 2 | Sponsor only | Wallet | Zoho, Meesho, Fractal | "Give us a prepaid pool; we don't want procurement on every ₹500 session." |
| 3 | Sponsor only | Invoice | Wipro, Infosys Procurement, any org with PO + NET-60 flow | "We can't prepay; send us an invoice monthly against a PO." |
| 4 | Sponsor only | License | IIT Madras for student coaching; any school paying a flat annual fee | "One cheque, year-round access." |
| 5 | Host only | — | GLG-style expert network; coaching institute with its own trainers | "We bring our own experts; we want a share of every booking." |
| 6 | Hybrid | Personal | Alumni network; professional body | "Our members already pay; we want our own experts to earn too." |
| 7 | Hybrid | Wallet | EdTech with its own coaches + paid customer base | "We buy seats for our staff and earn on outside customers booking our coaches." |
| 8 | Hybrid | Invoice | Corporate training partner | "Monthly invoice for our own employees + earn from public bookings of our trainers." |
| 9 | Hybrid | License | University with on-staff faculty | "Students get unlimited + our faculty earns on public students booking them." |

## How we make money

For every session booked on the platform we take a platform fee
(default 10% — negotiable on enterprise deals). When the session is
hosted by an org, we split the remainder between the org and the
expert according to a **rate card**. The default rate card pays:

- Platform: 10%
- Org:      10%
- Expert:   80%

Hosts can negotiate a different split. A university that employs its
faculty as full-time staff, for example, sets `Expert = 0%` on the
rate card and collects 90% itself (paying the faculty as salary
offline).

## Why this model beats a single flat enterprise SKU

- **Sponsor and host are independent.** A university can buy a
  license for students and host faculty without the two flows
  interfering. Neither is required to be true for a deal.
- **Funding is independent of capability.** A sponsor can change from
  Personal to Wallet to Invoice without re-signing a contract — it's
  one config flip.
- **Legal and billing mesh.** Every invoice is GST-compliant with
  CGST/SGST/IGST split, PO 3-way match, and the fields needed for
  e-invoicing (IRN, signed QR). Procurement teams nod at the PDF.
- **Audit ready.** Every admin action in the org dashboard — invite,
  role change, wallet top-up, contract signing — is immutable audit-
  logged. Security reviews take hours, not weeks.

## Common objections

- **"We already have an LMS / LXP."** We're not replacing that. We're
  the expert marketplace it integrates with. Add a "book 1:1 with an
  expert" button to your LMS and we handle the rest.
- **"Our L&D spend is already committed elsewhere."** Start with
  Personal funding — you get the dashboard and expert access at zero
  commitment. Upgrade to Wallet or Invoice when the pattern is
  proven.
- **"How does pricing scale?"** Per-session on Personal and Wallet
  (cost = session price × volume). Flat on License. Monthly total on
  Invoice (usually with a soft cap per user per month).

## Talking to a founder / CxO

The three questions to ask:

1. **"Are you paying for your people, earning from your experts, or
   both?"** → drives sponsor vs host vs hybrid.
2. **"If you're paying: do you want to prepay, postpay, or not
   commit?"** → drives wallet vs invoice vs personal.
3. **"If you're hosting: does your expert see the money, or does the
   org?"** → drives `PayoutRecipient` (marketplace vs
   internal/salaried).

Any "I don't know" on those questions means we haven't made the
mental model land. The playbook is: capability, then funding.

## Related docs

- `org-billing-playbook-technical.md` — the engineering playbook for
  each combination.
- `14-scenarios-and-examples.md` — four worked examples (Wipro,
  LearnPro, IIT Madras, a solo expert).
