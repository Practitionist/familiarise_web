# Legal Pages, Grievance & Age

## Context

Privacy/Terms pages exist under `app/(pages)/` but company constants still contain placeholders. Consumer Protection e-commerce rules expect grievance officer, timelines, seller info. Age: `dateOfBirth` optional; no gate. Professional licensing: manual doc review ≠ regulated profession compliance.

## Known gaps / bugs

- `[COMPANY NAME]`, `[ADDRESS]`, `[EMAIL]` placeholders — launch blocker in hiring/research notes.
- No `/grievance` page, no Grievance model, no 48h/30d SLA cron.
- No parental consent / 13+ or 18+ enforcement.
- No license number fields for CA/medical/legal verticals.
- CCPA dark-pattern self-audit documented as obligation without artifact.

## Unhappy paths & user psychology

- Angry customer has nowhere obvious to escalate; posts on social; Razorpay dispute.
- Minor uses platform for paid consult — regulatory + reputational blowup.
- Regulated professional misrepresents credentials; platform verification rubber-stamped.

## Questions (handled?)

1. **Age policy?**  
   - A) 18+ hard gate with DOB  
   - B) 13+ parental consent  
   - C) No restriction until DPDP Phase 3  

2. **Grievance officer — hire + page before GMV?**  
   - A) Before first paid consumer txn  
   - B) Shared founder email interim  
   - C) Enterprise MSA only; B2C later  

3. **Vertical licensing — marketplace trust or regulated?**  
   - A) Stay generalist ed-tech trust  
   - B) Build license verify for CA/legal/health  
   - C) Ban regulated advice categories  

## High concurrency / multi-device

Low; primarily policy. Multi-device signup should still hit same age gate once built.

## Suggested directions

Replace placeholders immediately. Publish grievance contacts. Decide age policy in writing.
