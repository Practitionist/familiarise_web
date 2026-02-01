# Notification Strategy — Novu Orchestration vs Direct Resend

> Analysis of whether to use Novu as a notification orchestrator or send emails directly through Resend.

**Status**: Design
**Decision Date**: 2026-02-02
**Related Issues**: #300 (In-App Notifications), #399 (Novu Webhook Receiver)

---

## Table of Contents

- [The Question](#the-question)
- [What Resend Alone Looks Like](#what-resend-alone-looks-like)
- [Where Direct Resend Starts to Hurt](#where-direct-resend-starts-to-hurt)
- [The Honest Tradeoff](#the-honest-tradeoff)
- [Novu Channel Capabilities](#novu-channel-capabilities)
- [Two Reasonable Paths](#two-reasonable-paths)
- [Decision](#decision)

---

## The Question

Why would we need an orchestrator (Novu) if we can directly send through Resend?

**Short answer**: You *can* skip Novu entirely and just call Resend directly everywhere. Many startups do exactly that. The question is whether the orchestration layer pays for itself at our scale.

---

## What Resend Alone Looks Like

Every time you need to send a notification, you write code like this:

```ts
// In your booking confirmation API route
await resend.emails.send({
  to: consultee.email,
  subject: "Booking Confirmed",
  template: "booking-confirmed",
  data: { consultantName, date, time }
});
```

You repeat this pattern in every API route — booking confirmed, payment received, payout sent, support ticket updated, trial converted, etc. It works. It's simple.

---

## Where Direct Resend Starts to Hurt

### 1. Multi-channel delivery

A consultee books a session. You want to send an email AND show a bell notification AND (later) a push notification. Without Novu:

```ts
// You write this in every API route that needs notifications
await resend.emails.send({ /* booking email */ });
await db.inAppNotification.create({ /* bell notification */ });
await firebase.send({ /* push notification */ });  // later
```

Three separate calls, three separate error handling paths, in every route. With Novu, it's one trigger:

```ts
await novu.trigger("booking-confirmed", { to: userId, payload: { ... } });
// Novu decides: email via Resend + in-app + push, respecting user preferences
```

### 2. User notification preferences

Our schema already has `NotificationPreference` with `emailEnabled`, `inAppEnabled`, `pushEnabled`, `quietHoursEnabled`, `appointmentReminders`, `paymentNotifications`, etc. Without Novu, *you* have to check all these preferences before every send:

```ts
const prefs = await db.notificationPreference.findUnique({ where: { userId } });

if (prefs.emailEnabled && prefs.appointmentReminders) {
  if (!isQuietHours(prefs)) {
    await resend.emails.send({ ... });
  }
}
if (prefs.inAppEnabled) {
  await db.inAppNotification.create({ ... });
}
```

That logic duplicated across 15+ notification types is where bugs creep in.

### 3. Digest / batching

A consultant gets 8 booking requests in an hour. Without Novu: 8 separate emails. With Novu: one digest email summarizing all 8, sent after a configurable delay.

### 4. Enterprise notifications at scale

When an enterprise org has 50 members and a new recording collection is published, without Novu you write a loop sending 50 emails with rate limiting and error handling. Novu handles fan-out natively.

---

## The Honest Tradeoff

| Factor | Resend Only | Resend + Novu |
|---|---|---|
| **Simplicity** | Simpler — one dependency | More moving parts |
| **Cost** | Resend only (~$20/mo) | Resend + Novu free tier (30k events/mo) |
| **Multi-channel** | You build it yourself | Built-in |
| **User preferences** | You code the logic | Declarative in workflow |
| **Digest/batching** | You build it yourself | Built-in |
| **Template management** | In your codebase | Novu dashboard (non-dev can edit) |
| **Delivery tracking** | Resend webhooks + your DB | Novu dashboard |
| **Time to add new notification** | Write full send logic | Add workflow, trigger it |

---

## Novu Channel Capabilities

| Channel | Needs External Provider? | Provider Examples |
|---|---|---|
| **In-App** (bell icon) | **No** — fully native | Novu handles this itself via WebSockets |
| **Email** | **Yes** — mandatory | Resend, SendGrid, SES, Mailgun, Postmark, or any Custom SMTP |
| **SMS** | **Yes** — mandatory | Twilio, Amazon SNS, Plivo, Vonage, Telnyx |
| **Push** (mobile) | **Yes** — mandatory | Firebase (FCM), Apple (APNS), OneSignal, Expo |
| **Chat** | **Yes** — mandatory | Slack, Discord, MS Teams |

**Novu cannot send emails or SMS on its own.** It's an orchestrator, not a delivery service. It needs external providers for every channel except in-app notifications, which are fully native (WebSocket-based, with read/unread state management, React SDK).

For our stack specifically:
- **Email delivery**: Resend (already in use for auth emails)
- **In-app notifications**: Novu handles natively, no extra service
- **SMS**: Twilio or MSG91 (popular in India) — optional, can be added later
- **Push**: Firebase (FCM) for the mobile app — also optional for now

---

## Two Reasonable Paths

### Path 1: Start with Resend only

Build a thin internal `notify()` helper that checks preferences and sends via Resend. Add Novu later when multi-channel (push, in-app) or digest becomes a real need.

**Best if**: You want minimal dependencies for MVP and don't need in-app bell notifications yet.

### Path 2: Start with Novu from day one

Issue #399 (Novu webhook receiver) and Issue #300 (in-app notification system) are already open. If you're building in-app bell notifications anyway, Novu gives you that for free without building your own WebSocket infrastructure.

**Best if**: You want in-app notifications (bell icon) without building custom WebSocket infrastructure. The in-app notification system — not email orchestration — is the strongest argument for Novu.

---

## Decision

**Path 2 — Start with Novu from day one.** The in-app notification infrastructure (WebSocket connections, read/unread state, real-time updates, notification center UI) is non-trivial to build from scratch. Novu provides this natively while also handling email routing through Resend, user preference checking, and digest batching.
