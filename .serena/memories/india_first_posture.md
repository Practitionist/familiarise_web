# India-first, always

**Owner instruction, 2026-09-29: "Prioritize the Indian market over the American
market or stuff… We are 90% Indian customers, maybe 10% foreigners in the future."**

Settled. Do not re-ask. Default legal frame is DPDP + IT Act/IT Rules + CPA +
CERT-In + CBDT, not GDPR/CCPA.

Full reference with the staged commencement dates, what is enforceable today,
the residency position and the open questions: **`docs/compliance/01-india-first-posture.md`**.

## The traps

1. **Dates.** DPDP ss.3-17 etc. commence **13 May 2027** (G.S.R. 843(E),
   13 Nov 2025). The 14 Nov date floating around is the *PIB press release* date,
   not the notification. Consent Managers (s.6(9)/r.4) come earlier:
   **13 Nov 2026**. MeitY has publicly proposed cutting 18 months to 12, so
   13 Nov 2026 is a live possibility. IT Act s.43A + SPDI Rules 2011 are
   **binding law today** and only repealed 13 May 2027.
2. **Enforce-now vs 2027.** The live clocks are IT Rules 24h/15d, CERT-In 6h
   reporting and 180-day in-India logs, the GAC appeal (free, online, binding).
   The 2027 cohort is the DPDP notice/consent/erasure/penalties. Check the live
   ones first.
3. **GDPR shapes are wrong here.** No "sale/share", no cookie CMP/GCM, no SCC
   programme, no Art.27 rep, no HIPAA. A US-first stack misses the things that
   actually bite: notice architecture, *purpose* inventory, grievance
   *workflow*, proactive s.8(7) erasure, processor erasure fan-out.
4. **DPDP is not a localisation law.** s.16/Rule 15 is a may-restrict power about
   exposure to a *foreign State*. The only hard India-storage rules are CERT-In
   logs and RBI payment data. Sentry has no India region and the choice is
   immutable. Keep payment data out of Sentry entirely — that is what breaks
   Razorpay's RBI compliance.
5. **ToS change != data consent.** Separate instruments, separate records. A ToS
   re-acceptance can never carry new data-processing consent. And India has no
   compatibility-assessment mechanism, so every new purpose needs fresh consent
   with no "close enough" carve-out.
6. **The Board is unstaffed** and there is **no s.17 startup exemption** (it is a
   power requiring a notification naming us; none exists). Penalties are fixed
   rupee ceilings, not turnover-linked. Neither fact is permission.

## Working rules

- When asked for a privacy/compliance recommendation, lead with the Indian
  requirement and cite it. Cite GDPR/CCPA only for the ~10% foreign slice, and
  say so explicitly.
- Prefer a *purpose* inventory to a data-category inventory; DPDP s.5/s.7 run on
  purposes.
- Flag the genuinely unsettled points (withdrawal-implies-erasure; 22-language
  notice; s.194-O vs s.194-J) for counsel rather than picking a side silently.
