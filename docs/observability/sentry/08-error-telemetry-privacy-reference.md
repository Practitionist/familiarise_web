# Error telemetry and privacy: a reusable reference

This page exists because error monitoring is the one observability signal that
carries personal data by design, and because the questions it raises — can I
send this to a US-hosted vendor, what is my lawful basis, does consent settle
it, how do I honour an erasure — get answered badly in both directions. Too
often the answer is a confident legal statement made by an engineer, or a
privacy posture adopted without reading the payload.

**Write it for someone who has never seen this repository.** That is deliberate:
the page was written to be lifted into a different company, and nothing in it
depends on knowing this codebase. Where a statement is specific to this
repository it is marked **This repository:** and the path is given, so you can
find the corresponding thing in yours and ignore it otherwise. Everything else
is general.

Three conventions run through the whole page, and they are load-bearing:

- **† marks a legal determination, not a finding.** A dagger means: I read the
  text, and the text is not the question you actually need answered. Somebody
  qualified has to make that call in writing. Nothing in this page is legal
  advice, and no statement here should be read as saying that any arrangement
  complies with, satisfies, or is consistent with the Data Protection Act 2023
  or anything else. I have deliberately avoided that vocabulary throughout.
- **Every legal and market claim carries a date.** A privacy position decays;
  a pricing page decays faster. If you are reading this in 2028, the law below
  is probably out of date and the prices definitely are.
- **Vendor behaviour is measured, not assumed.** Section 6 is the part that
  changed my mind most, and it changed it because the measured answer
  contradicted the documented one in two separate cases.

Research and measurement dates: legal position and industry practice as at
**2026-09-29**; vendor region facts as at **2026-09-29**; SDK wire-payload
measurements taken **2026-09-29** against `@sentry/nextjs` 10.59.0, 10.75.3 and
11.1.0.

## 1. Bottom line

If you are deciding today whether to send error telemetry to a US-hosted Sentry
from an India-based company: nothing in force today prohibits it. The
provision that could — §16(1) of the DPDP Act 2023 — has not commenced, has
never been notified, and is drafted as a power rather than a duty, so a
prohibition cannot exist until the Central Government exercises it. That is the
short answer, and on its own it is a bad reason to do nothing, because 13 May
2027 is a hard date, the drafting intent is not ambiguous, and the operational
consequences of turning a scrub on after you have a year of events are much
worse than turning it on before you have one. The finding I would most want
you to take from the industry research is a negative one: **nobody is doing
anything special.** Sentry's own customer index contains two Indian entries and
both use hosted Sentry; no Indian source describes a DPDP mitigation for it;
nobody pins Sentry to the EU region as a DPDP measure; and no consent-gating of
error telemetry was found anywhere in the world, not in India and not
elsewhere. There is no pattern to copy, and that absence is itself the finding —
it means the differentiator will not be your vendor choice, it will be whether
you can show what you send. The part that is measurably dangerous is not the
law, it is the payload: I captured SDK wire traffic and found a cleartext email
address in a query string on one patch version, a timezone that no
configuration key strips, and a major-version rename that silently re-enables
the query-string leak. Build the scrub-at-source gate now, because it is the
only control that works, because Sentry's own guidance says server-side
scrubbing is not the answer, and because it is cheap before you have data to
delete. And get the two legal determinations made in writing by a lawyer —
§16 and the surviving 2011 Rule 7 — because the gap that actually bites a
company at audit is the written record, not the absence of a prohibition.

## 2. The statutory position

### §16(1), verbatim

> The Central Government may, by notification, restrict the transfer of
> personal data by a Data Fiduciary for processing to such country or territory
> outside India as may be so notified.

Three features of that sentence carry the entire analysis, and all three are
frequently misreported.

**It is a "may", not a "shall."** Nothing obliges the government to notify.
Absence of a notification is therefore not a permission that was granted; it is
the current state of a power that has not been used. That distinction matters
because "the government has not restricted anything" and "the government has
affirmed this is fine" are very different sentences to hand to a regulator or
a customer, and only the first is true.

**It says "a Data Fiduciary", not "a Significant Data Fiduciary."** As at
2026-09-29 a large amount of 2026 commentary states that §16 binds only SDFs.
That is wrong on the face of the text: §16 uses the general defined term, and
the SDF qualifier appears in the localisation rule instead (Rule 13(4), below).
If your compliance note reaches the right operational answer via the SDF-only
route, it is resting on a premise a lawyer will correct in front of you, and
you will lose the room you need for the arguments that actually matter. Say it
correctly the first time.

**There is no destination and no category in the text.** The section names a
country or territory "as may be so notified" — the scope is set entirely by a
future notification, not by the statute.

### It has not commenced, and the date is known

**G.S.R. 843(E), notified 13 November 2025**, deferred commencement of a group
of provisions on the standard 18-month runway, which puts them at **13 May
2027**. That group includes **§§11–17** (so §16), **§6** (the lawful-basis
provision, which is why the lawful-basis question cannot be answered today
either), and **Rule 15** (the contractual requirement to specify the purpose,
the extent of processing, and the manner and duration of the transfer in a
contract or other instrument with a data principal in India). †

### No notification has ever been issued

As at 2026-09-29, four independent trackers agree that **no §16(1) notification
has been issued** — not a partial one, not a sectoral one, not one naming
certain countries. This is the most stable fact in the whole area and the one
most likely to change first.

### There is no approved-country list, because there is no such concept

This is the second most common error and it is the more expensive one, because
it produces an expensive retrofit. **There is no approved-country list anywhere
in the Act or the Rules.** India is a negative-list regime: nothing is
restricted until it is named. It is _not_ GDPR Chapter V. That means there is
no standard contractual clauses requirement, no transfer impact assessment, no
binding corporate rules, and no consent-as-a-route-to-transfer mechanism — not
because they were relaxed, but because **none of those concepts exist** in this
statute and inventing them is importing another jurisdiction's machinery that
will not fit the local one. A company that has copied an SCC clause into its
vendor paperwork has written a document that answers a question the law does
not ask, and has not answered the question it does.

### The one localisation rule that does exist

**Rule 13(4) of the DPDP Rules** is the only localisation-style provision in
force, and it is **double-gated**:

1. it binds only a **Significant Data Fiduciary**; and
2. it binds them only in relation to data **"specified by the Central
   Government"** — a specification that has not been made.

No SDF has been designated, and **§10**, the provision that empowers
designation, is itself in the 18-month group deferred to 13 May 2027. So the
provision is gated behind a designation power that does not yet exist, applied
to a specification that has not been issued. †

**A citation correction worth carrying:** several secondary sources cite this
as "Rule 12(4)". That is wrong — Rule 12 deals with processing of children's
data. If a vendor questionnaire or a consultant's memo gives you Rule 12(4),
you are reading a document that misidentified the only rule in the Act that
could have mattered, which is reasonable evidence that the rest of it was not
read carefully either.

### Enforcement is not real, and pretending otherwise is its own risk

The Data Protection Board was **established 13 November 2025** but had **no
chairperson and no members as at 4 September 2026**. §27 (the Board's
investigative and enforcement powers) and §§28–34 (the penalty provisions) do
not commence until 13 May 2027. As at 2026-09-29 there are **zero** published
enforcement actions, penalties, show-cause notices or advisories — not on
cross-border transfers, and not on anything else.

Two things follow, and they pull in opposite directions. First, there is no
enforcement risk to speak of today, so a panic-driven migration is not
rationale-driven. Second — and this is the one teams get wrong — **an absent
regulator is not the same as an absent obligation.** The customers you sign
DPA-like terms with, the enterprise questionnaires you answer, and the legal
counsel you retain will all be reading the statute rather than the enforcement
record. "Nobody has been penalised for this" is a fact about a regulator that
has no members; it is not a position you want to have written down.

### The 2011 rules still govern, and they bite a narrower set of data

The Information Technology (Reasonable Security Precautions and Procedures
and Sensitive Personal Data or Information) Rules, **2011**, Rule 7 still
govern today. It permits transfer of **sensitive personal data or information**
outside India where it is necessary for the performance of a contract with the
data principal, or where the data principal has consented. The defined
sensitive categories are passwords, financial information, physical,
physiological, mental, medical or health information, sexual orientation, and
medical or health records.

Whether a **pseudonymous error-monitoring identifier** falls inside that list
is a one-line question and I am not going to answer it. It is not established,
the answer is not obviously "no" — an identifier is not obviously outside a
list about identifying information, and an identifier that resolves through a
lookup table is closer to identification than a random token is — and it is
precisely the kind of question where an engineer's reading of a definition is
worth less than an hour of a privacy lawyer's time. † Treat it as open.

### What the practitioners are advising

**Bar & Bench, 18 September 2026** — the most on-point practitioner piece I
found on this exact question — argues **against** acting now. Its position is
resist inserting SCC-style transfer machinery into vendor contracts, because
that machinery answers a question this statute does not ask; instead insert a
**"regulatory change" clause** obliging the parties to renegotiate when Rule 15
and any §16 notification take effect. And use the window for **structural
readiness** — mapping data flows, mapping the vendor chain, mapping
sub-processors — because that work is worth doing regardless of which way the
regulation lands. That is the right shape of advice: cheap, reversible, and
useful under either outcome.

## 3. What the industry actually does

I went looking for a pattern and there isn't one, which is the finding. Read
this section before assuming that somebody else's posture is a shortcut.

### Indian companies do use hosted Sentry SaaS

Sentry publishes a customer index of roughly seventy stories. **Exactly two of
them are Indian**, and both are on hosted Sentry:

| Company                             | What the source says                                                                                                                                 | Hosted?                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **DoctorC** (Bengaluru, healthcare) | Self-hosted first, then moved to "Sentry's SaaS offering" / a "cloud-based error monitoring platform" — Sentry's own words, in a healthcare business | Yes                                                                             |
| **Grofers** (now Zepto)             | Sentry quotes VP Eng Vaidik Kapoor: "For the past 5 years, Sentry has served as an integral part of Grofers code monitoring process"                 | Genuinely undetermined — neither the story nor the quote settles hosted vs self |

Corroborating signals, weaker but consistent: **Freshworks** lists Sentry in
its own Hyderabad Android job requirements, and Indian job boards showed
101–116 Sentry-tagged roles as at 2026-09-29. That is a company in Bengaluru
hiring engineers to work on Sentry integrations, which is not the behaviour of
a market that has collectively routed around it.

**A correction I have to make to my own earlier work, because it is the kind of
error that propagates.** An earlier pass at this page asserted that no Indian
company uses hosted Sentry. That was **wrong**. It came from a pass that never
read Sentry's own customer index — the single most authoritative source
available — and inferred absence from a general web search that had not
returned Indian results. If you are about to repeat a negative claim in this
domain, read the vendor's own customer material first, because the vendor is
the only party who reliably knows who their customers are, and because a
negative claim is the one kind of claim that nobody downstream thinks to check.

### The self-hosting examples exist, and their reasons are not about data egress

- **Zerodha** — the CTO, **28 July 2021**: "We self-host and self-manage
  everything… monitoring and tracking systems including Sentry and Grafana",
  corroborated again in December 2024.
- **Razorpay** — built in-house Jaeger-based tracing after moving off APM
  vendors, **11 February 2022**, citing **capability, the ability to replay
  traffic for compliance, and cost**.

Read those reasons carefully before borrowing them. Razorpay's stated motives
are a capability decision, a compliance-replay decision and a cost decision.
Data residency is not among them. A self-hosted stack is a defensible answer to
_many_ questions, and citing Razorpay as precedent for _self-hosting to keep
personal data in India_ is reading a conclusion into a source that does not
contain it.

### The finding: there is nothing to copy

Across everything read on 2026-09-29:

- **No Indian source describes a DPDP mitigation for Sentry.** Not one.
- **Nobody pins Sentry to the EU region as a DPDP measure.** Nobody.
- **No consent-gating of error telemetry was found anywhere in the world** —
  not in India, not in the EU, not in the United States.

The honest reading is that this is a category nobody has solved, not a category
where a solution is being kept quiet. If you are looking for prior art to
justify a posture, there is none, and you will have to construct the argument
yourself — which is a reason to have a lawyer construct it rather than to
assume the risk is zero because nobody else seems to worry.

## 4. Sentry's regions, and why EU pinning is not a DPDP answer

**Exactly two regions exist: US (Iowa) and EU (Frankfurt).** The region is
selected when the organisation is created and is **immutable** — the only way
to change it is to create a new organisation and migrate. **There is no India
region at any plan tier.** That is a documented absence on first-party
evidence (Sentry's own storage and plans documentation), not a region I failed
to find, and the distinction matters when you are writing a vendor
questionnaire: "no India region" and "we have not asked" produce very different
records.

### An EU organisation still keeps a category of data in the United States

This is the part that makes EU pinning a weak answer, and it is on Sentry's own
documentation. Even on the EU region, these are replicated to the US:

- user accounts;
- 2FA authenticators;
- organisation integration metadata;
- access tokens;
- organisation settings and **audit logs**;
- project metadata;
- **DSN keys**;
- SSO / SAML / SCIM metadata;
- "metadata that lets Sentry identify an organization", for login.

Uptime-check data may be stored outside the selected region, and
support-ticket data is stored in the US.

So the transfer happens anyway. What EU pinning changes is _which_ transfer you
are making and under _which_ legal system — a GDPR-shaped remedy for a
GDPR-shaped worry. No Indian source recommends it as a DPDP measure, and
importing it would mean importing the reasoning that produced it, which
requires an approved-country list that this statute does not have.

### Why it is the wrong thing to buy, specifically

1. It does not stop the transfer you actually have (§16 has no
   approved-country concept, so "approved country" reasoning does not map; and
   the data lands in the US regardless).
2. It is **immutable after creation**, so it is a decision you can make once and
   never revise — including when you later learn something that changes the
   analysis. A control you cannot revise is not a mitigation you are managing.
3. No one in this market has identified it as a DPDP measure, so it would be
   an unmotivated line item you would have to explain to a customer.

### The control that does work: scrub before transmission

Sentry's own guidance, and it is worth reading in full because it retracts the
instinct most people arrive with:

> if the requirement is "this data must never leave our systems," don't rely on
> Sentry's server-side scrubbing. Remove it in the SDK (or an
> infrastructure-controlled Relay) before transmission.

Two things follow and both are easy to miss. First, server-side scrubbing is
not the primary control — it is a net for what you already sent, and a
**non-retroactive** one. Second, **Relay** is the structural version of this:
an infrastructure-controlled proxy you operate, sitting between the SDK and
Sentry's ingest, where you can drop fields without shipping a client change.
For any company whose requirement is a hard residency or minimisation
boundary, Relay-or-SDK is the only architecture that answers it.

## 5. India-region alternatives

There is **no India-hosted Sentry SaaS** (as at 2026-09-29). There are, however,
India regions in the wider observability tier, and the shape of each one
determines whether it is a real substitute or a different product. Prices are
as quoted on **2026-09-29** and will have moved.

| Option                          | India region?                                            | Shape                              | Price quoted 2026-09-29 | What it means for you                                                                                                                                                                               |
| ------------------------------- | -------------------------------------------------------- | ---------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SigNoz Cloud**                | **Yes** — US / EU / **India**; Bengaluru-founded, YC W21 | Hosted SaaS                        | Teams $49/mo            | The closest thing to a drop-in. Not Sentry-API-compatible, so the SDK, the `beforeSend` hooks, the query syntax and the triage joins all have to be rewritten                                       |
| **Grafana Cloud**               | **Yes** — AWS `ap-south-1`, GCP `asia-south1`            | Hosted SaaS                        | Consumption-based       | Strong option if you already run Prometheus/Loki/Tempo. Error tracking is a component, not the product                                                                                              |
| **Elastic Cloud**               | **Yes** — Mumbai, Pune                                   | Hosted SaaS                        | Consumption-based       | You own the retention problem directly and can delete by query, which is a real advantage when erasure has to be provable                                                                           |
| **OpenObserve Cloud**           | **Yes** — Mumbai, GA 2026-06-02                          | Hosted SaaS                        | $0.50/GB                | Youngest and cheapest of the hosted set; least proven at scale                                                                                                                                      |
| **AppDynamics**                 | **Yes** — AWS Mumbai since Oct 2020                      | Hosted SaaS                        | Enterprise              | Explicitly positioned on data sovereignty; APM rather than error-first, and expensive                                                                                                               |
| **CubeAPM** (Gurgaon)           | In **your** VPC                                          | Self-hosted in your infrastructure | $0.15/GB                | Indian vendor, and a real observability product. Customers include PolicyBazaar, Delhivery, Practo, Mamaearth, Shiprocket. In-your-VPC is the strongest residency answer and the weakest ops answer |
| **ESDS Enlight Garud** (Nashik) | Sovereign on-premises                                    | Self-hosted                        | —                       | Multi-tenant sovereign cloud is a **Q4 2026 roadmap item, not shipping**. Treat as unavailable                                                                                                      |
| **GlitchTip**                   | Hosted, but **US + EU only**                             | Hosted SaaS, Sentry-API-compatible | Free / $15 / $50 / $250 | A genuinely drop-in Sentry-API-compatible option, but it does not solve an India-residency requirement on its own. **Elestio** offers managed GlitchTip and can place it in AWS Mumbai from $11/mo  |
| **Managed Sentry**              | —                                                        | —                                  | —                       | **Does not exist.** Nobody packages it. Elestio's equivalent Sentry page 404s — verified 2026-09-29                                                                                                 |

**The honest reading of that table.** Every option that gives you an India
region gives it at the cost of Sentry API compatibility, and every option that
keeps Sentry API compatibility does not give you an India region. Those two
facts are the whole trade. If your requirement is "the data stays in India",
you are choosing a different error tracker and budgeting for the integration.
If your requirement is "we know exactly what leaves", you keep hosted Sentry
and build the scrub at source — and on the current state of the law that is
very likely the better trade.

## 6. What the SDK actually sends: measured, on the wire

Everything in this section was measured on **2026-09-29** by capturing the
actual envelopes the SDK puts on the wire, across `@sentry/nextjs` **10.59.0**,
**10.75.3** and **11.1.0**. Not read from documentation. Assumed from
documentation. The difference is the point of the section.

| Finding                                                                                                                                                                                                                 | Versions                      | Consequence                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`Sentry.setUser()` is sent regardless of `dataCollection`.** Sentry's own docs say so explicitly                                                                                                                      | all three                     | A config-level `userInfo: false` **cannot** withhold a user id. Only the call site can. Any "we don't send PII" claim resting on `userInfo: false` is false the moment anyone calls `setUser` |
| **`userInfo: false` strips the IP address.** No IP in the payload by header, cookie or query string in any version — the integration drops all twelve IP-bearing header names. With `userInfo: true` the IP does appear | all three                     | This one was the opposite of my assumption, and in the good direction. A config key that suppresses a field you did not know was there is a genuine control                                   |
| **`contexts.culture.timezone` survives in every version** and is **not gated by anything in `dataCollection`**                                                                                                          | all three                     | A timezone is a coarse location signal. No setting removes it, so it needs a `beforeSend` hook — a scrub, not a config flag                                                                   |
| **`queryParams: false` did not strip query strings from `event.request.url`** — an email address and a token were captured in cleartext. Fixed in 10.75.3                                                               | 10.59.0 broken; 10.75.3 fixed | The clearest evidence on this page that **privacy behaviour is version-specific and must be measured, not assumed**                                                                           |
| **v11 renames `queryParams` to `urlQueryParams` with no fallback, and v11's default is `true`**                                                                                                                         | 11.1.0                        | A v11 upgrade carrying only the v10 key **silently resumes sending query strings**. Keep both keys, and pin the version deliberately                                                          |

### The lesson, stated explicitly

**Measure, don't assume — and then re-measure on every upgrade.** Two of the
five rows above are cases where the documented intent and the measured
behaviour differed, in opposite directions: a setting that was supposed to
suppress the user id does not, and a setting that was not supposed to suppress
the IP does. If you rely on either from documentation you will be wrong, and in
each case wrong in a direction you would not predict.

The v11 rename deserves its own note because it is the failure mode that
survives a review. Nothing breaks, no test fails, no deprecation warning
appears — the key is simply no longer read, and the **new key's default is
`true`**. The leak returns quietly. Any key in a privacy configuration is a
thing that can be renamed, re-defaulted, or quietly reordered in a major
version, so pin the SDK version on purpose and keep a test that fails when a
key disappears from the config object. A privacy config that no test reads is a
comment.

### What no client-side measurement can answer

The payload is what the SDK puts in the event, not what Sentry's edge observes.
Their ingest endpoint sees the **connecting IP address regardless of
`dataCollection`**, and scrubbing is **never retroactive** for events already
accepted. Both belong in your privacy review as open questions, not as resolved
facts. If a requirement genuinely is "this never leaves our systems", the only
honest answer is the Relay architecture from section 4, and the only honest
evidence is the vendor's own written confirmation of what its edge retains.

## 7. The consent question, which is subtler than it looks

A signup checkbox for error monitoring is a good instinct. It is necessary for
the lawful-basis question. It is **not sufficient**, for four independent
reasons, and any one of them is enough to sink a design that relies on it:

1. **The Act gives §16 no consent route at all.** A checkbox does nothing if a
   destination is ever restricted by notification, because consent is not one of
   the mechanisms the section contemplates. The two questions — "do we have a
   lawful basis for the processing" and "may this be transferred out of India" —
   are separate, and a checkbox only touches the first. †
2. **Consent is not even the operative basis today**, because **§6 has not
   commenced until 13 May 2027**. The provision that would tell you what basis
   is available does not yet exist, so a consent artefact built now is being
   built against a law that has not started.
3. **A signup checkbox cannot actually stop error telemetry.** The DSN is
   compiled into the client bundle; the SDK is initialised and reporting
   regardless of what the user clicked. Honouring a per-user choice requires a
   **per-user gate in the SDK's send hook** — and for a user who has _not_
   consented, the correct implementation is a send hook that drops the event
   before it is serialised, not a checkbox that the SDK never reads. If your
   consent flow is not wired to a send hook, it is a UI affordance and not a
   control, and it should not be described as one.
4. **B2B breaks a single checkbox.** Where an organisation sponsors a booking,
   the consultant or participant is a **separate data principal** from the
   organisation, with their own consent position, and a signup checkbox on the
   organisation's account says nothing about them. Any B2B consent design has
   to answer per-person, and "per-person" is the expensive version.

### The point that should stop a team

**An unauditable consent is worse than none.** A checkbox with no consent
artefact behind it is a claim you cannot evidence and a withdrawal obligation
you cannot discharge. You will have told a data principal something, and be
unable to prove what they agreed to or when; and when they withdraw, you will
have no record of the state to roll back to. The correct sequence is
artefact-first, checkbox-second: capture a tamper-evident artefact (who, what,
which version of the text, when, and a hash) **before** you build the interface
that collects the click, because retrofitting an artefact onto a consent you
have already been collecting is materially harder than the reverse.

## 8. A reusable checklist

Written for a team standing this up from scratch, in the order that actually
works. The ordering is the point: the cheap, reversible, reusable work comes
first, and the thing that is expensive to retrofit (deleting data you already
sent) comes last.

### Before you write any code

- [ ] **Decide the region as an irreversible decision.** Sentry's region is
      fixed at organisation creation. Whatever you choose, you are choosing
      for the life of the org.
- [ ] **Write down the data-flow answer before you choose a vendor**: what
      fields you intend to send, which of them are personal data, and which
      country each one lands in. You cannot answer a vendor questionnaire or a
      customer DPA from intuition.
- [ ] **Map the vendor chain and the sub-processor list** — including the
      accessors you do not pay (support tooling, error trackers, session replay
      vendors). This is the structural-readiness work Bar & Bench recommends for
      exactly this window, and it is worth doing under any regulatory outcome.

### Before you send anything

- [ ] **Capture the actual wire payload and read it.** Do not trust the
      documentation. Point the SDK at a proxy or a canary, trigger a known
      error, and read the envelope. Budget an afternoon; it is the highest
      return-on-time step on this list.
- [ ] **Set `dataCollection` explicitly, naming every category you do not
      want.** Do not rely on defaults. Watch the traps: a category that
      defaults to `true`, and a field whose documented type is an object rather
      than a boolean.
- [ ] **Set both spellings of any renamed key** and pin the SDK version. Add a
      test that fails when a key vanishes from the config object.
- [ ] **Add a `beforeSend` scrub** for everything the config cannot reach.
      Assume there is something it cannot reach — on 2026-09-29 that was
      `contexts.culture.timezone`, and the general rule holds regardless of
      which field it is this year.
- [ ] **Put the scrub in the SDK, not only in the vendor's dashboard.** If the
      requirement is "this must never leave", that is the only place it can be
      met. Treat dashboard scrubbing as a net, and remember it is not
      retroactive.
- [ ] **Ask the vendor, in writing, what its edge retains** — including the
      connecting IP and its retention window. No client-side measurement can
      answer this, and it is the question your customer's DPO will ask.

### Before you switch identity on

- [ ] **Decide who identifies whom.** An opaque internal id is a defensible
      posture; an email or a phone number in an error payload is not, and it
      will outlive your reasoning.
- [ ] **Understand that a stable pseudonym is not a weak anonymisation.** It is
      a durable link back to one account, it is correlatable across every event
      that account ever produced, and it is **not** equivalent to a requester IP
      — which identifies a location that changes with the connection and is often
      shared, and which therefore correlates weakly. The comparison table in
      this repository's [identity and triage](05-identity-and-triage.md) §"What
      is deliberately not sent" sets the two out field by field; the short form
      is that you would be trading a weak signal for a strong one, and that is a
      real increase in disclosure regardless of how small the id looks.
- [ ] **Default the disclosure off.** Make the on-state an explicit,
      exact-match environment value. A privacy gate that a typo can enable is
      not a gate.
- [ ] **Understand the cost of being wrong is not symmetric.** An unattributable
      error is an operational cost you can fix by flipping a switch later. A
      disclosed pseudonym that turns out to have been unlawful cannot be
      withdrawn from the processor's copy. Default off, and let whoever owns the
      legal call make it.
- [ ] **Plan the erasure story before you need it.** A stable pseudonym in
      historical events is only erased when the event ages out or is deleted —
      a stable id does not un-send itself. Know your retention window, know
      whether the vendor exposes a per-user deletion API you would have to
      call, and never describe partial revocability to a data principal as
      erasure.

### Standing items

- [ ] **A consent artefact before a consent checkbox**, per section 7.
- [ ] **A "regulatory change" clause in vendor contracts** — obliging the parties
      to renegotiate when Rule 15 and any §16 notification take effect. This is
      the practitioner recommendation from Bar & Bench, 18 September 2026, and it
      is cheap now and awkward later.
- [ ] **Re-run the payload measurement on every SDK upgrade**, and re-date
      every legal claim before you rely on it. This page was researched
      2026-09-29; §16 could have been notified the day after you read it.

## 9. What is unresolved, and what needs a lawyer

### Unresolved, and owned by nobody but you

These are engineering and documentation facts that are simply not established.
They are on this list rather than in the body because they are the gaps that
will be found in an audit, and the fix for each is a person writing something
down.

- [ ] The **active plan's retention window** for your error processor. Plan
      dependent, not visible from configuration, and it determines how long a
      pseudonym stays correlatable. Do not record a number until you have
      confirmed the plan.
- [ ] **What your vendor's edge retains** — connecting IP, request metadata,
      any backup or replica outside the selected region. Only the vendor can
      answer this, and the answer belongs in the file.
- [ ] **Whether a sub-processor register exists and names your observability
      processor.** A missing register is a different finding from a missing row
      in it, and only the first is fixable by adding one line.
- [ ] **Whether your privacy notice mentions error monitoring at all** —
      purpose, processor, region, retention. Consumers cannot be given notice
      of a disclosure that is not described.
- [ ] **The residual SDK enrichment that no config key reaches.** As at
      2026-09-29 that was `contexts.culture.timezone` on every event, sent
      regardless of any identity gate, because it is an SDK default rather than
      your labelling. Until a scrub hook exists, this is flowing on every event.
- [ ] **The re-measurement interval.** Section 6 is a snapshot of three
      versions on one day. It is not a property of the SDK.

### Needs a lawyer's determination, in writing

Every item below is a legal question. I have deliberately not answered any of
them, and no engineer, code review or DPO sign-off substitutes for a written
determination from a qualified lawyer.

1. **Does a §16(1) notification, when it comes, restrict the destination you are
   using** — and if it names countries rather than categories, how do you read a
   sub-processor relationship against it? (§16, G.S.R. 843(E), 13 Nov 2025,
   13 May 2027; as at 2026-09-29 no notification exists.)
2. **Does the surviving 2011 Rule 7 apply to a pseudonymous error-monitoring
   identifier**, on the "sensitive personal data or information" list or off
   it? This is a one-line definitional question with a genuinely arguable
   answer, and it is the one most likely to be answered wrongly by assumption.
3. **What is the lawful basis for the processing** once §6 commences on 13 May
   2027, and is consent among the options it actually offers?
4. **What must the contract with the processor and the data principal contain**
   under Rule 15 when it commences — and should you be writing to the
   regulatory-change-clause shape Bar & Bench recommends instead?
5. **What is owed to a data principal on an erasure request, given that a stable
   pseudonym in a historical event cannot be withdrawn** and no Sentry
   equivalent of a scrub-and-forget API exists in the plan this is running on.
6. \*\*Whether a "regulatory change" clause, a data-flow map, or a subprocessor
   register closes the record sufficiently for your enterprise customers, or
   whether they will require SCC-style terms that the statute does not
   contemplate — and how to respond to a questionnaire that asks for them
   anyway.

**This repository** has this list tracked in more detail, with owners and
phases, in [`docs/compliance/08-dpdp-and-privacy.md`](../../compliance/08-dpdp-and-privacy.md)
("Required H", and Gap #14). The engineering side of the same disclosure is in
[05 identity and triage](05-identity-and-triage.md); the reason a specific
identity switch exists and defaults off is in
[`lib/observability/identity.ts`](../../../lib/observability/identity.ts), and
the payload measurement is pinned as a test in
[`__tests__/observability/sentry-data-collection.test.ts`](../../../__tests__/observability/sentry-data-collection.test.ts).

## 10. Sources

**A note on URLs, because it is a deliberate choice.** For the legal
instruments I have given **publisher, document title, notification number and
date** rather than a deep link, because a deep link to a government PDF that
has been reorganised rots silently and a rotted link in a compliance document
is worse than a title you can find in one search. Root domains are given so you
know where to look. For vendor documentation, where URLs do not rot the same
way, I have given the paths I am confident in; treat any single path as
"the section by this name under this product's docs" and navigate from the root
domain.

### Primary

| Source                                                                                                                                                                                                  | Publisher                                                                 | Date                                                                      | Used for                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Digital Personal Data Protection Act, 2023, **§16(1)** — full text as quoted in section 2                                                                                                               | Parliament of India / MeitY                                               | Act 2023; position as at 2026-09-29                                       | The "may" wording, the "a Data Fiduciary" wording, absence of any destination or category |
| **G.S.R. 843(E)** — notification deferring commencement of certain provisions                                                                                                                           | Gazette of India (egazette.gov.in)                                        | 13 Nov 2025                                                               | The 18-month group: §§11–17, §6, §10, Rule 15 → **13 May 2027**                           |
| Digital Personal Data Protection Rules, 2020 (as notified, as amended) — **Rule 13(4)**, **Rule 12**                                                                                                    | MeitY                                                                     | Rules 2020; position as at 2026-09-29                                     | The only localisation rule, its double gate, and the Rule 12(4) mis-citation correction   |
| Information Technology (Reasonable Security Precautions and Procedures and Sensitive Personal Data or Information) Rules, **2011**, Rule 7 and the definition of sensitive personal data or information | Gazette of India / MeitY                                                  | 2011; still operative as at 2026-09-29                                    | The surviving transfer restriction and the sensitive-data list                            |
| Data Protection Board — establishment, composition and commencement of §§27, 28–34                                                                                                                      | Gazette of India / MeitY                                                  | Established 13 Nov 2025; composition and powers status checked 4 Sep 2026 | No chairperson or members as at 4 Sep 2026; enforcement powers not commenced              |
| Sentry storage regions, region immutability, per-region data handling, sub-processors                                                                                                                   | Sentry first-party documentation — `docs.sentry.io`                       | Read 2026-09-29                                                           | Two regions, immutability, the EU→US replication list, uptime and support data locations  |
| Sentry data-scrubbing and Relay documentation ("don't rely on Sentry's server-side scrubbing…")                                                                                                         | Sentry first-party documentation — `docs.sentry.io`                       | Read 2026-09-29                                                           | Scrub at source; scrubbing is not retroactive                                             |
| Sentry JavaScript SDK options — `dataCollection`, `userInfo`, `queryParams`/`urlQueryParams`, `httpHeaders`, `stackFrameVariables`                                                                      | Sentry first-party documentation — `docs.sentry.io/platforms/javascript/` | Read 2026-09-29                                                           | Documented intent, which section 6 then measured against                                  |
| Sentry customer index — DoctorC and Grofers/Zepto stories                                                                                                                                               | Sentry first-party — `sentry.io/customers`                                | Read 2026-09-29                                                           | The two Indian entries, their quotes, and the correction in section 3                     |
| SigNoz, Grafana Cloud, Elastic Cloud, OpenObserve Cloud, AppDynamics, CubeAPM, ESDS Enlight Garud, GlitchTip, Elestio — region and pricing pages                                                        | Each vendor's own site                                                    | Read 2026-09-29                                                           | The table in section 5                                                                    |

### Secondary

| Source                                                                                                                                                      | Publisher                             | Date                               | Used for                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Practitioner piece arguing against acting now; recommends a "regulatory change" clause over SCC-style machinery, and structural readiness during the window | **Bar & Bench**                       | 18 Sep 2026                        | Section 2's closing advice and the standing checklist item                                                     |
| Zerodha CTO on self-hosting Sentry and Grafana                                                                                                              | Zerodha (first-party blog)            | 28 Jul 2021, corroborated Dec 2024 | The self-hosting example, and that its reasons are operational                                                 |
| Razorpay's move to in-house Jaeger tracing after leaving APM vendors                                                                                        | Razorpay engineering                  | 11 Feb 2022                        | The self-hosting example whose stated motives are capability, compliance replay and cost — **not** data egress |
| Four independent trackers of §16 notifications and commencement                                                                                             | Various compliance and legal trackers | Aug–Sep 2026                       | The "no notification has ever been issued" finding, from more than one source                                  |
| Sentry-tagged role counts on Indian job boards; Freshworks Hyderabad Android job requirements listing Sentry                                                | Job boards; Freshworks careers page   | Read 2026-09-29                    | Corroborating evidence that Indian engineering orgs build on Sentry                                            |

**On the four trackers and the practitioner piece:** I read them as corroboration,
not as authority. Where they agree with primary text I have cited the primary
text, and where a secondary source contradicts primary text I have followed the
text and flagged the contradiction — the "SDF-only" reading of §16 and the
"Rule 12(4)" citation are both cases where the secondary consensus is wrong on
the face of the instrument, and both would have been adopted by anyone who
stopped at the commentary.
