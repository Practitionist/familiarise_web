# Cross-Cutting — Multi-Device Psychology

## Context

Real users do not use one browser tab. They bounce between phone, laptop, iPad, WhatsApp OTPs, UPI apps, and email deep links. Familiarise is largely a **web** product with server-authoritative mutations, but client state and third-party SDKs (Razorpay, Stream, Novu, OAuth) create multi-surface races.

## Known gaps / bugs (cross-system)

- Platform onboarding: same email, two roles, two devices → last write wins.
- Checkout: new idempotency keys per remount/tab if not shared.
- Booking calendars: stale green slots across devices.
- Waitlist: notify on email/phone; claim on another device without soft hold.
- Referrals: localStorage attribution dies across devices.
- Stream video: multi-tab join → echo / duplicate sessions.
- Auth: OAuth completes on one device; other tabs need broadcast; onboarding drafts diverge.
- Payments: UPI on phone while desktop modal open — success invisible until refresh.
- Notifications: preference toggles disagree across APIs/devices.
- Support: parallel tickets from phone + desktop for one payment.

## Unhappy paths & user psychology (catalogue)

1. **Double identity intent** — consultant firm signup on laptop + consultee curiosity on phone.  
2. **Payment anxiety** — OTP on phone; desktop shows failure; user pays twice.  
3. **Meeting panic** — join on iPad then phone “for audio”; call ruined.  
4. **False availability** — old tab overnight; slot expired; blame the product.  
5. **Referral betrayal** — shared link; signup elsewhere; no reward.  
6. **Org admin split brain** — SSO enforce on laptop; password attempt on phone blocked opaquely.  
7. **Approve twice** — consultant taps approve on two devices; second 409 feels broken.  
8. **Dispute storm** — cancel on web, dispute in bank app, ticket in support — three truths.

## Questions (handled?)

1. **Product principle for multi-device?**  
   - A) Server truth + aggressive refetch; allow parallel sessions  
   - B) Single active session per user (kick others)  
   - C) Soft warnings when parallel mutating sessions detected  

2. **Where to invest first?**  
   - A) Onboarding CAS + checkout key persistence  
   - B) Stream single-session  
   - C) Cross-device pending-payment banner  

3. **Mobile strategy?**  
   - A) Responsive web + WebView payments  
   - B) Native SDK later  
   - C) PWA install prompts  

## High concurrency / multi-device

Treat every user as N concurrent clients. Idempotency, CAS, and clear 409 copy matter more than perfect UI sync. Prefer banners: “You have a payment in progress,” “You joined this call elsewhere,” “Onboarding continued as ROLE on another device.”

## Suggested directions

Ship three banners above before new features: pending payment, active call elsewhere, onboarding role lock. Add chaos tests for dual-device onboarding and dual-tab checkout.
