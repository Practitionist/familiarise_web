# India-first compliance posture

**Standing instruction from the repo owner. Applies to every compliance, privacy,
data-handling and legal-analysis task in this repo. Take it as settled; do not
re-ask.**

## The instruction

> Prioritize the Indian market over the American market or EU. We are 90% Indian
> customers, maybe 10% foreigners in the future.

Consequences for how you work:

- **The default legal frame is Indian law** — DPDP Act 2023 + DPDP Rules 2025,
  IT Act 2000, IT Rules 2021, Consumer Protection Act 2019, Consumer Protection
  (E-Commerce) Rules 2020, CERT-In Directions 2022, CBDT s.194-O. Reach for
  GDPR/CCPA only for the ~10% foreign slice, and label it as such.
- **A GDPR-shaped analysis is usually the wrong analysis.** Several US-first
  workstreams are pure waste here: CCPA "sale/share" and opt-out links, the
  state-by-state US patchwork, cookie-consent CMP/GCM programmes, HIPAA,
  GDPR Art 44-49 SCC/BCR/adequacy for India, Article 27 EU representatives.
  Don't build them unless asked.
- **Some US-first workstreams are actively insufficient, not merely irrelevant.**
  These are the ones to check first: notice architecture (DPDP s.5 + Rule 3 need a
  standalone itemised notice, not a marketing privacy policy); a _purpose_
  inventory rather than a data-category inventory; a grievance _workflow_ with
  24h/15d acknowledgement-and-disposal, not a contact mailbox; proactive
  erasure under s.8(7) rather than delete-account-on-request; and a processor
  inventory with erasure fan-out.
- **Dates matter enormously and are staged.** Get them right; do not guess.

## Dates that are load-bearing

| What                                                              | Date             | Source                     |
| ----------------------------------------------------------------- | ---------------- | -------------------------- |
| DPDP operative sections (ss.3-17, 19-33, penalties s.33) commence | **13 May 2027**  | G.S.R. 843(E), 13 Nov 2025 |
| DPDP s.6(9) + Rules r.4 (Consent Managers) commence               | **13 Nov 2026**  | G.S.R. 843(E)              |
| IT Act s.43A + SPDI Rules 2011 repealed                           | **13 May 2027**  | G.S.R. 843(E) s.44(2)(a)   |
| Consumer Protection (E-Commerce) Amendment Rules 2026 in force    | **1 Jan 2027**   | CG-DL-E-10092026-276125    |
| IT Act s.43A + SPDI Rules 2011                                    | **in force now** | until 13 May 2027          |

⚠ **The 18-month window is under live pressure.** On 22 Jan 2026 MeitY proposed
cutting 18 months to 12, which would pull the deadline to **13 Nov 2026**. No
amending instrument notified as of Sep 2026. Treat 13 May 2027 as the deadline
and 13 Nov 2026 as plausible. Re-verify before relying on either.

⚠ **A common error to avoid:** the 13 Nov 2025 _notification_ date vs the
14 Nov 2025 _PIB press release_ date. Several trackers (PRS, EY, some firms)
inherited the PIB date. The gazette says 13 Nov 2025, so 18 months is
13 May 2027.

## What is enforceable TODAY (do not let these slide)

1. **IT Rules 2021 r.3(2)(a)(i)** — acknowledge a grievance within **24 hours**,
   dispose within **15 days**. Not a guideline; a rule.
2. **CERT-In Directions 28.04.2022** — cyber incident report within **6 hours**;
   ICT logs retained **180 days inside India**; a nominated Point of Contact.
   Binds "any entity whatsoever", so it reaches us as a body corporate. **This is
   the only hard India-localisation rule that binds us directly.**
3. **IT Rules r.3(1)(f)** — notify users of changes to the privacy policy or
   user agreement, at least annually, if we are an intermediary. (We almost
   certainly are: PRS lists online marketplaces as intermediaries.)
4. **IT Rules r.3(1)(h)** — retain registration data **180 days after
   cancellation/withdrawal**.
5. **IT Rules r.3A** — Grievance Appellate Committee is **live and free** at
   gac.gov.in. 30 days to appeal, GAC aims to resolve in 30 days, order is
   binding. A functioning, no-cost Indian escalation path.
6. **E-Commerce Rules** — INR price display with charge break-up (r.5(1)); no
   pre-ticked boxes (r.3(2)); seller grievance 48h/1 month (r.6(4)(b)).
7. **CBDT s.194-O** — 0.1% TDS on gross sales of resident e-commerce
   participants, ₹5 lakh individual carve-out. **The structuring question is
   open**: are we the facilitator (194-O) or the principal service provider
   (194-J at 10%)? Unresolved here, and it decides our consultants' tax
   treatment. Needs tax advice, not engineering.

## The two instruments, and why they must stay separate

|            | Contract acceptance (ToS)              | Data-processing consent (DPDP s.6)                   |
| ---------- | -------------------------------------- | ---------------------------------------------------- |
| Instrument | contract, IC Act ss.10/10A             | permission for a _specified purpose_                 |
| Trigger    | ToS change                             | new/changed purpose                                  |
| Acceptance | fresh; may be implied by conduct (s.9) | **clear affirmative action, s.6(1)** — never implied |
| Withdrawal | close the account                      | stop processing, keep the account                    |

**A ToS change can never carry new data-processing consent.** Bundling is the
named anti-pattern (GDPR Art 7(4); EDPB Guidelines 03/2022). India has no
express anti-bundling clause today, which is _not_ permission — the 2026
e-commerce amendment imports the DPDP standard into consumer-adjacent
regulation, and the foreign slice needs the stricter rule anyway.

Note there is **no Indian compatibility-assessment mechanism**, so unlike GDPR
Art 6(4) there is no "close enough purpose" carve-out. Every new purpose needs
fresh consent. The purposes list is a hard boundary.

## Data residency — the actual position

- **DPDP imposes no data localisation.** s.16 / Rule 15 is a _may-restrict_ power
  aimed at exposure to a **foreign State**, not an adequacy regime. Transfer is
  permitted by default; the CG restricts by order.
- **The two hard India-storage rules are CERT-In (logs) and RBI (payment data)** —
  and only the first binds us directly.
- **RBI** (6 Apr 2018 circular + 26 Jun 2019 FAQs) does not bind us; it binds
  Razorpay, and reaches us **contractually**. Razorpay will impose KYC-onboarding
  of every consultant before payout. **Sharpest Sentry risk: never let a payment
  error push amounts, order ids or Razorpay payloads into an overseas Sentry
  project** — that would break Razorpay's compliance.
- **Sentry has no India region** (US and EU only), and the region choice is
  immutable. If it is ever revisited, EU/Frankfurt beats US. Either way,
  scrub payment fields hard and keep a separate payment project.
- **Cross-border transfer today: nothing required.** No adequacy list in force
  (SPDI Rules 2023 short negative list was never notified), no SCCs, no filing.
  Do not build a GDPR transfer programme for India.

## Board and enforcement reality

- **Data Protection Board: established, unstaffed.** G.S.R. 844(E)/845(E), 13 Nov
  2025, 4 members; no Chairperson or Member appointed as of Sep 2026. It is "a
  body corporate on paper alone". Do not rely on it existing to enforce — and do
  not treat its absence as permission.
- **No relief available.** s.17(3) startup/SME exemption is a _power_ requiring
  a notification naming us; none exists. And it would only remove ss.5, 8(3),
  **8(7)**, 10, 11 — it would not touch s.6 consent, s.8(5) security, s.8(6)
  breach, or s.16. **Plan for full compliance.**
- **Penalties are fixed rupee ceilings, not turnover-linked** (unlike GDPR's 4%):
  ₹250 cr for s.8(5) security failures, ₹50 cr for breaching _any other_
  provision or Rule. Realised sums go to the Consolidated Fund — the individual
  recovers nothing. Exposure is reputational plus headline, not solvency.

## Open questions — flag, do not guess

- Does withdrawal imply erasure? ICO says yes (PECR), Bavarian DPA says no, CJEU
  C-129/21 scopes it to the purpose. **Genuinely unsettled. Resolve per-purpose
  in writing.**
- Must the notice be in all 22 Schedule VIII languages? Our `language` field is
  write-only, never read by a gate, and always `"en-IN"`.
- Are we a facilitator (s.194-O) or principal (s.194-J)?
- Does the 30-day self-imposed erasure turnaround survive DPDP s.12's regime?
- The ITC/CIT "unfair contract term" test (CPA s.2(46)) imports the EU
  unfairness test's _structure_ without its remedy architecture. Notice quality
  does not save an unfair **term**.

## Related issues

- **#1880** — consent state machine design (ask/pending/withdrawn states,
  notice-versioning, withdrawal vs erasure, processor fan-out).
- **#1879** — per-user telemetry consent, privacy/terms rewrite, DPDP workstream.
- **#1881** — hotfix PR off `dev`: retention clock, Novu erasure leak, doc lies.
