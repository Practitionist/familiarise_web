# Notifications — Overview

## Context

Dual path: **Resend** for auth/payment/waitlist transactional email; **Novu** for 40+ product workflows (appointments, support, reviews, referrals, collaborators, org events). `NotificationPreference` rich model; **two APIs** (legacy narrow toggles vs full Novu sync). Subscriber sync on signup. Failed email retry job. Push/SMS/WhatsApp largely missing (roadmap).

## Known gaps / bugs

- Preference API duplication — different shapes, user confusion.
- Push/FCM marked missing in ecosystem docs despite schema fields.
- Quiet hours stored; enforcement depends on Novu dashboard rules — drift risk.
- Fire-and-forget Novu triggers — duplicate events on webhook retries possible.
- If Novu unset, workflows silently skip — “notifications broken” with no user-visible reason.
- Marketing consent (`MARKETING_COMMS`) not stamped at signup (#701 follow-up).
- Directus broadcast webhook stub (#312).

## Unhappy paths & user psychology

- User disables email in one settings page; other API still sends — feels ignored.
- Critical payment email works (Resend) but in-app bell empty (Novu down) — split brain.
- Quiet hours violated because Novu cloud rule differs from app toggle.
- Multi-device: read state not synced across tabs beyond Novu subscriber model.

## Questions (handled?)

1. **Long-term orchestration?**  
   - A) Novu for all product events  
   - B) In-house for critical; Novu for engagement  
   - C) Resend-only simplify  

2. **Push before mobile app?**  
   - A) Skip  
   - B) Web push first  
   - C) Build with native app  

3. **Unify preference APIs?**  
   - A) Deprecate legacy immediately  
   - B) Facade over both  
   - C) Keep legacy for mobile docs  

## High concurrency / multi-device

Duplicate notifications under webhook storms — prefer idempotent workflow keys. `auth-broadcast` syncs login, not notification reads. Multi-device preference edits last-write-wins.

## Suggested directions

One preferences UI/API. Fail loud in staging when Novu missing. Stamp marketing consent explicitly.
